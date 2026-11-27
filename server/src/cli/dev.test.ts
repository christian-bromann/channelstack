import { describe, expect, test } from "vitest";

import { harness } from "../../test/app-harness.ts";
import { DEV_CHANNELS } from "../drivers/index.ts";
import { actionsOf, runAct, runChannel } from "./act.ts";
import { type Attached, CliError } from "./attach.ts";
import { devChannel, runReact, runReply, runSay, runShow } from "./dev.ts";

/** An attachment to an app in memory: the commands call its control API as they would a server's. */
function attached(): Attached {
  const h = harness();
  let dev: Promise<string> | undefined;
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const reply = await h.call(method, path, body);
    if (reply.status >= 400) throw new CliError(reply.body?.message ?? `refused (${reply.status})`);
    return reply.body as T;
  };
  return {
    url: "http://127.0.0.1:4500",
    request,
    devSession: () => {
      dev ??= request<{ sessionId: string }>("POST", "/sessions", { name: "dev" }).then(({ sessionId }) => sessionId);
      return dev;
    },
  };
}

/** Per channel: where its people talk, an action of its own, and what that action leaves in the transcript. */
const CASES: Record<
  string,
  { place: string; act: { action: string; values: Record<string, unknown> }; acted: RegExp }
> = {
  slack: {
    place: "#support",
    act: { action: "edit", values: { text: "hello there", message: "last" } },
    acted: /hello there/,
  },
  github: { place: "Login fails", act: { action: "close", values: {} }, acted: /.*/ },
  linear: { place: "Crash on start", act: { action: "setState", values: { state: "In Progress" } }, acted: /.*/ },
  notion: { place: "Roadmap", act: { action: "rename", values: { title: "Roadmap 2027" } }, acted: /Roadmap 2027/ },
  resend: {
    place: "Refund",
    act: { action: "send", values: { to: "app", subject: "Another", text: "one more" } },
    acted: /one more/,
  },
  google: {
    place: "Refund",
    act: { action: "send", values: { to: "app", subject: "Another", text: "one more" } },
    acted: /one more/,
  },
};

describe("the dev tools on every channel", () => {
  test("every channel has a dev adapter, a case here, and actions generated from its routes", () => {
    expect(DEV_CHANNELS.map(({ name }) => name).sort()).toEqual(Object.keys(CASES).sort());
    for (const { name } of DEV_CHANNELS) expect(actionsOf(name).length).toBeGreaterThan(0);
  });

  for (const { name } of DEV_CHANNELS) {
    const { place, act, acted } = CASES[name] as (typeof CASES)[string];
    test(`${name}: say, reply, react, show and act, by names and \`last\``, async () => {
      const server = attached();
      const channel = devChannel(name);

      // Ana and the place don't exist yet: saying something makes both, with the app in it.
      const said = await runSay(server, channel, "@my-agent hi", { as: "ana", in: place });
      expect(said).toMatch(new RegExp(`^ana said it in ${place.replace(/^#/, "#?")} \\(\\S+:\\S+\\)\\n$`));
      // The same place again, by its name, with another person who joins it.
      expect(await runSay(server, channel, "me too", { as: "ben", in: place })).toMatch(/^ben said it in /);
      expect(await runShow(server, channel, {})).toMatch(/ana: [\s\S]*hi[\s\S]*ben: me too/);

      expect(await runReply(server, channel, "and then?", { as: "ana", to: "last" })).toMatch(
        /^ana replied \(\S+\)\n$/,
      );
      expect(await runShow(server, channel, { in: place })).toContain("and then?");
      // `show --json` lists the entries with the ids a reference names.
      const entries = JSON.parse(await runShow(server, channel, { json: true })) as Array<{ id: string; text: string }>;
      expect(entries.at(-1)?.text ?? "").toBeDefined();

      if (channel.adapter.react) {
        expect(await runReact(server, channel, ":eyes:", { as: "ben", on: "last" })).toMatch(
          /^ben reacted with :eyes:/,
        );
      } else {
        await expect(runReact(server, channel, ":eyes:", { as: "ben" })).rejects.toThrow(/don't react/);
      }

      // One of the channel's own actions, its references filled from `last`.
      const done = await runAct(server, channel, act.action, {
        positional: [],
        values: act.values,
        flags: { as: "ana" },
      });
      expect(done).toMatch(new RegExp(`^ana did ${act.action}`));
      expect(await runShow(server, undefined, {})).toMatch(acted);
    });
  }

  test("the CLI's commands: a place by name, an action with values in order, and mistakes in a sentence", async () => {
    const server = attached();
    await runChannel(server, "slack", "say", ["@my-agent hi"], { as: "ana", in: "#support" });
    expect(await runChannel(server, "slack", "show", [], { in: "support" })).toBe("ana: @my-agent hi\n");
    // `edit` takes its text first, and the message is `last`'s.
    expect(await runChannel(server, "slack", "edit", ["@my-agent hello"], { as: "ana", message: "last" })).toMatch(
      /^ana did edit on C\w+:\d+\.\d+/,
    );
    expect(await runChannel(server, "slack", "show", [], {})).toBe("ana: @my-agent hello (edited)\n");
    // Without `--as`, whoever started the thread acts.
    expect(await runChannel(server, "slack", "act", ["delete"], { message: "last" })).toMatch(/^ana did delete/);
    expect(await runChannel(server, "slack", "actions", [], {})).toMatch(/^say\(message: SlackMessageInput/m);

    await expect(runChannel(server, "slack", "say", ["hi"], { in: "#support" })).rejects.toThrow(
      "say who is acting with `--as <name>`",
    );
    await expect(runChannel(server, "slack", "nope", [], { as: "ana" })).rejects.toThrow(/has no action "nope"/);
    await expect(runChannel(server, "teams", "say", [], {})).rejects.toThrow(/unknown channel "teams"/);
    await expect(runChannel(server, "notion", "react", [":eyes:"], { as: "ana" })).rejects.toThrow(
      "people don't react on Notion.",
    );
  });
});
