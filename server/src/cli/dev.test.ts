import { describe, expect, test } from "vitest";

import { type Harness, harness } from "../../test/app-harness.ts";
import { DEV_CHANNELS } from "../drivers/index.ts";
import { actionsOf, describeAction, runAct, runChannel } from "./act.ts";
import { type Attached, CliError } from "./attach.ts";
import { devChannel, runReact, runReply, runSay, runShow } from "./dev.ts";

/** An attachment to an app in memory: the commands call its control API as they would a server's. */
function attached(h: Harness = harness()): Attached & { h: Harness } {
  let dev: Promise<string> | undefined;
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const reply = await h.call(method, path, body);
    if (reply.status >= 400) throw new CliError(reply.body?.message ?? `refused (${reply.status})`);
    return reply.body as T;
  };
  return {
    h,
    url: "http://127.0.0.1:4500",
    request,
    devSession: () => {
      dev ??= request<{ sessionId: string }>("POST", "/sessions", { name: "dev" }).then(({ sessionId }) => sessionId);
      return dev;
    },
  };
}

/** The reference a command printed in parentheses. */
const referenceIn = (printed: string) => /\((\S+:\S+)\)\n$/.exec(printed)?.[1] ?? "";

/**
 * Per channel: where its people talk, and one action of its own whose effect a person sees in the
 * transcript. Each action needs a reference it isn't given (the issue, the message, the app), which
 * the target fills in.
 */
const CASES: Record<
  string,
  { place: string; act: { action: string; values: Record<string, unknown> }; acted: RegExp }
> = {
  slack: {
    place: "#support",
    act: { action: "edit", values: { text: "hello there" } },
    acted: /hello there \(edited\)/,
  },
  github: {
    place: "Login fails",
    act: { action: "comment", values: { body: "from an action" } },
    acted: /ana: from an action/,
  },
  linear: {
    place: "Crash on start",
    act: { action: "comment", values: { body: "from an action" } },
    acted: /ana: from an action/,
  },
  notion: { place: "Roadmap", act: { action: "rename", values: { title: "Roadmap 2027" } }, acted: /Roadmap 2027/ },
  resend: {
    place: "Refund",
    act: { action: "send", values: { to: "app", subject: "Another", text: "one more" } },
    acted: /ana: one more/,
  },
  google: {
    place: "Refund",
    act: { action: "send", values: { to: "app", subject: "Another", text: "one more" } },
    acted: /ana: one more/,
  },
  discord: {
    place: "#support",
    act: { action: "edit", values: { text: "hello there" } },
    acted: /hello there \(edited\)/,
  },
};

describe("the dev tools on every channel", () => {
  test("every channel has a dev adapter, a case here, and actions generated from its routes", () => {
    expect(DEV_CHANNELS.map(({ name }) => name).sort()).toEqual(Object.keys(CASES).sort());
    for (const { name } of DEV_CHANNELS) expect(actionsOf(name).length).toBeGreaterThan(0);
  });

  for (const { name } of DEV_CHANNELS) {
    const { place, act, acted } = CASES[name] as (typeof CASES)[string];
    test(`${name}: say, reply, react, show and act, by names, references and \`last\``, async () => {
      const server = attached();
      const channel = devChannel(name);

      // Ana and the place don't exist yet: saying something makes both, with the app in it.
      const said = await runSay(server, channel, "@my-agent hi", { as: "ana", in: place });
      expect(said).toMatch(new RegExp(`^ana said it in ${place.replace(/^#/, "#?")} \\(\\S+:\\S+\\)\\n$`));
      // The same place again, by its name, with another person who joins it.
      expect(await runSay(server, channel, "me too", { as: "ben", in: place })).toMatch(/^ben said it in /);
      expect(await runShow(server, channel, {})).toMatch(/ana: [\s\S]*hi[\s\S]*ben: me too/);

      // A reference as `say` printed it names Ana's first words; Ben answers those.
      expect(await runReply(server, channel, "and then?", { as: "ben", to: referenceIn(said) })).toMatch(
        /^ben replied \(\S+:\S+\)\n$/,
      );
      expect(await runShow(server, channel, { in: place })).toMatch(/ben: and then\?/);
      // `show --json` lists the entries with the ids a reference names.
      const entries = JSON.parse(await runShow(server, channel, { json: true })) as Array<{ id: string }>;
      expect(entries.some((entry) => referenceIn(said).endsWith(`:${entry.id}`))).toBe(true);

      if (channel.adapter.react) {
        // Ben's reply is the newest entry, and a comment on every channel that has them.
        expect(await runReact(server, channel, ":eyes:", { as: "ben" })).toMatch(
          /^ben reacted with :eyes: \(\S+:\S+\)\n$/,
        );
      } else {
        await expect(runReact(server, channel, ":eyes:", { as: "ben" })).rejects.toThrow(/don't react/);
      }

      // One of the channel's own actions, on Ana's first words (`--on`), its references filled from them.
      const done = await runAct(server, channel, act.action, {
        positional: [],
        values: act.values,
        flags: { as: "ana", on: referenceIn(said) },
      });
      expect(done).toMatch(new RegExp(`^ana did ${act.action}`));
      expect(await runShow(server, undefined, {})).toMatch(acted);
    });
  }

  test("`last` is the newest entry anywhere, however precisely a channel writes its times", async () => {
    const server = attached();
    const github = devChannel("github");
    // Two issues, and the first is active again.
    const later = () => server.h.clock.advance(10);
    await runSay(server, github, "first", { as: "mo", in: "Older" });
    later();
    await runSay(server, github, "second", { as: "mo", in: "Newer" });
    later();
    await runSay(server, github, "back here", { as: "mo", in: "Older" });
    later();
    await runReply(server, github, "the answer", { as: "ana", to: "last" });
    expect(await runShow(server, github, { in: "Older" })).toMatch(/back here\nana: the answer\n$/);
    expect(await runShow(server, github, { in: "Newer" })).not.toContain("the answer");

    // Across channels: what was said last, on whichever channel.
    later();
    await runSay(server, devChannel("slack"), "hi there", { as: "ana", in: "#general" });
    expect(await runShow(server, undefined, {})).toBe("ana: hi there\n");
    later();
    await runSay(server, devChannel("notion"), "a note", { as: "ana", in: "Plans" });
    expect(await runShow(server, undefined, {})).toMatch(/ana: a note\n$/);

    // The issue said on last is the newest.
    later();
    await runSay(server, github, "later still", { as: "mo", in: "Newer" });
    expect(await runShow(server, undefined, {})).toMatch(/mo: later still\n$/);

    // `/places` lists them in that order, for the UI.
    const session = await server.devSession();
    const places = (await server.h.call("GET", `/sessions/${session}/places`)).body as Array<{
      channel: string;
      name: string;
    }>;
    expect(places.map(({ channel, name }) => `${channel} ${name}`)).toEqual([
      "github Older",
      "slack #general",
      "notion Plans",
      "github Newer",
    ]);
  });

  test("a label or a close on an issue leaves its newest entry's time as it was", async () => {
    const server = attached();
    const github = devChannel("github");
    // At the start of a second, so all of it happens within the second GitHub's own times are written to.
    server.h.clock.advance(1000 - (server.h.clock.now() % 1000));
    const later = () => server.h.clock.advance(10);
    await runSay(server, github, "on the issue", { as: "mo", in: "Older" });
    later();
    await runSay(server, devChannel("slack"), "in between", { as: "ana", in: "#general" });
    later();
    // Both change the issue, not what was said on it: Slack's message is still the newest.
    await runChannel(server, "github", "label", ["bug"], { as: "mo", in: "Older" });
    expect(await runShow(server, undefined, {})).toBe("ana: in between\n");
    later();
    await runChannel(server, "github", "close", [], { as: "mo", in: "Older" });
    expect(await runShow(server, undefined, {})).toBe("ana: in between\n");

    const session = await server.devSession();
    const places = (await server.h.call("GET", `/sessions/${session}/places`)).body as Array<{
      channel: string;
      name: string;
    }>;
    expect(places.map(({ channel, name }) => `${channel} ${name}`)).toEqual(["github Older", "slack #general"]);
  });

  test("actions: values in order or by name, a place by `--in`, ids as their type, and who acts", async () => {
    const server = attached();
    const github = devChannel("github");
    await runSay(server, github, "first", { as: "mo", in: "Login fails" });
    await runSay(server, github, "second", { as: "mo", in: "Docs typo" });

    // `--in` picks the place, though another one is newer; values come in order.
    expect(
      await runAct(server, github, "comment", {
        positional: ["in the older one"],
        values: {},
        flags: { as: "ana", in: "Login fails" },
      }),
    ).toMatch(/^ana did comment on dev#1:/);
    expect(await runShow(server, github, { in: "Login fails" })).toMatch(/ana: in the older one\n$/);

    // A comment's id typed on the command line is text; GitHub takes it as the number it is.
    const listed = JSON.parse(await runShow(server, github, { in: "Login fails", json: true })) as Array<{
      id: string;
    }>;
    const comment = listed.at(-1)?.id ?? "";
    expect(await runChannel(server, "github", "edit", ["edited"], { as: "ana", comment })).toMatch(/^ana did edit/);
    expect(await runShow(server, github, { in: "Login fails" })).toMatch(/ana: edited \(edited\)\n$/);

    // Without `--as`, whoever started the target's thread acts: Mo, whose words are the newest there.
    expect(await runChannel(server, "github", "close", [], { in: "Docs typo" })).toMatch(/^mo did close/);
    // A place nothing was said in has nobody to act for.
    await runChannel(server, "slack", "invite", ["ben"], { as: "ana", in: "#quiet" });
    await expect(runChannel(server, "slack", "kick", ["ben"], { in: "#quiet" })).rejects.toThrow(
      "say who acts with `--as <name>`.",
    );

    // An issue named for the first time is made, and the action is on it, by its handle.
    expect(await runChannel(server, "github", "label", ["bug"], { as: "mo", in: "Brand new" })).toMatch(
      /^mo did label on dev#3:/,
    );
    expect(await runChannel(server, "linear", "setState", ["In Progress"], { as: "lu", in: "Fresh" })).toMatch(
      /^lu did setState on \S+-1:/,
    );
    // A DM is named by what it is.
    await runAct(server, devChannel("slack"), "openDM", { positional: ["app"], values: {}, flags: { as: "ana" } });
    const session = await server.devSession();
    const places = (await server.h.call("GET", `/sessions/${session}/places`)).body as Array<{ name: string }>;
    expect(places.map(({ name }) => name)).toContainEqual(expect.stringMatching(/^Direct message D\w+$/));
    // Nobody else joins it: a DM is between two.
    const dm = places.map(({ name }) => name).find((name) => name.startsWith("Direct message")) ?? "";
    await expect(runSay(server, devChannel("slack"), "me too", { as: "ben", in: dm })).rejects.toThrow(
      `${dm} is a direct message, which can't take another person: open a group message with all of you (\`openDM\`).`,
    );

    // Linear: delegating to the app (filled in), then Stop on the agent session it opened.
    await runSay(server, devChannel("linear"), "please", { as: "lu", in: "Crash" });
    expect(await runChannel(server, "linear", "delegate", [], { as: "lu", in: "Crash" })).toMatch(/^lu did delegate/);
    expect(await runChannel(server, "linear", "stop", [], { as: "lu", in: "Crash" })).toMatch(/^lu did stop/);
  });

  test("the CLI's commands: a place by name, an action by its name or `act`, and mistakes in a sentence", async () => {
    const server = attached();
    await runChannel(server, "slack", "say", ["@my-agent hi"], { as: "ana", in: "#support" });
    expect(await runChannel(server, "slack", "show", [], { in: "support" })).toBe("ana: @my-agent hi\n");
    expect(await runChannel(server, "slack", "edit", ["@my-agent hello"], { as: "ana", message: "last" })).toMatch(
      /^ana did edit on C\w+:\d+\.\d+/,
    );
    expect(await runChannel(server, "slack", "show", [], {})).toBe("ana: @my-agent hello (edited)\n");
    // Without `--as`, whoever started the thread acts.
    expect(await runChannel(server, "slack", "act", ["delete"], { message: "last" })).toMatch(/^ana did delete/);
    expect(await runChannel(server, "slack", "actions", [], {})).toMatch(/^say\(message: SlackMessageInput/m);
    // A list of handles of several kinds reads as one.
    const assign = actionsOf("github").find((action) => action.name === "assign");
    expect(describeAction(assign as NonNullable<typeof assign>)).toMatch(/assignees: \(GitHubUser \| GitHubApp\)\[\]/);

    await expect(runChannel(server, "slack", "say", ["hi"], { in: "#support" })).rejects.toThrow(
      "say who is acting with `--as <name>`",
    );
    await expect(runChannel(server, "slack", "nope", [], { as: "ana" })).rejects.toThrow(/has no action "nope"/);
    await expect(runChannel(server, "teams", "say", [], {})).rejects.toThrow(/unknown channel "teams"/);
    await expect(runChannel(server, "notion", "react", [":eyes:"], { as: "ana" })).rejects.toThrow(
      "people don't react on Notion.",
    );
    // A review's verdict isn't a comment: reacting to it says so, and to the issue it doesn't.
    await runChannel(server, "github", "say", ["please review"], { as: "mo", in: "Docs" });
    const change = JSON.stringify([{ path: "README.md", content: Buffer.from("# hi\n").toString("base64") }]);
    await runChannel(server, "github", "push", [change], { as: "mo", branch: "docs" });
    await runChannel(server, "github", "openPullRequest", ['{"from":"docs","title":"Fix the docs"}'], { as: "mo" });
    await runChannel(server, "github", "review", ['{"event":"COMMENT","body":"looks fine"}'], {
      as: "ana",
      in: "Fix the docs",
    });
    await expect(runChannel(server, "github", "react", [":eyes:"], { as: "mo", on: "last" })).rejects.toThrow(
      "that entry is a review's verdict",
    );
    // On Linear, people react to comments, not to the issue.
    const said = await runChannel(server, "linear", "say", ["it crashes"], { as: "lu", in: "Crash" });
    await expect(
      runChannel(server, "linear", "react", [":eyes:"], { as: "lu", on: referenceIn(said) }),
    ).rejects.toThrow("on Linear people react to comments");

    // A place whose name has a colon is still found by its name.
    await runChannel(server, "github", "say", ["hi"], { as: "mo", in: "Bug: login" });
    expect(await runChannel(server, "github", "show", [], { in: "Bug: login" })).toMatch(/^mo: Bug: login\nhi\n$/);
    expect(await runChannel(server, "github", "reply", ["ok"], { as: "mo", to: "Bug: login" })).toMatch(/^mo replied/);
  });
});
