import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { harness } from "../../../../test/app-harness.ts";
import { SIGNED_OUT, slackClientStub } from "../../../../test/slack-client-stub.ts";
import { type SlackStub, slackStub } from "../../../../test/slack-live-stub.ts";
import { storageStatePath, writeStorageState } from "../../../core/browser/index.ts";

/** A server whose Slack driver is live against the stub: the app's credentials and the allowlist set, as in CI. */
function liveSlack(stub: SlackStub, allowlist = stub.team, extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "channelstack-live-"));
  const client = slackClientStub(stub);
  const h = harness(
    {},
    {
      live: {
        env: {
          CHANNELSTACK_SLACK_APP_ID: "A0STUBAPP1",
          CHANNELSTACK_SLACK_BOT_TOKEN: stub.bot.token,
          CHANNELSTACK_LIVE_SLACK_TEAMS: allowlist,
          CHANNELSTACK_RUN_ID: "unit1",
          ...extra,
        },
        fetch: stub.fetch,
        apiBase: { slack: stub.apiBase },
        home,
        launchBrowser: client.launch,
      },
    },
  );
  /** A person signed in once with `channelstack login`: their saved session, where the browser actor looks. */
  const signIn = (name: string, userId: string) =>
    writeStorageState(storageStatePath(home, "slack", name), {
      cookies: [{ name: "d", value: userId, domain: ".slack.com" }],
    });
  const open = async () => {
    const { body } = await h.call("POST", "/sessions", {});
    return {
      id: body.sessionId as string,
      slack: (method: string, path: string, payload?: unknown) =>
        h.call(method, `/sessions/${body.sessionId}/slack${path}`, payload),
    };
  };
  return { ...h, open, signIn, home, client };
}

describe("exit check 5.3: allowlists hold", () => {
  test("a workspace outside CHANNELSTACK_LIVE_SLACK_TEAMS is refused before anything is done there", async () => {
    const stub = slackStub({ team: "T0NOTALLOWED" });
    const ana = stub.person("ana");
    const server = liveSlack(stub, "T0SANDBOX01");
    const session = await server.open();

    const person = await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    expect(person.status).toBe(403);
    expect(person.body.error).toBe("live_not_allowlisted");
    expect(person.body.message).toContain("CHANNELSTACK_LIVE_SLACK_TEAMS");

    // Every action after it is refused the same way, without asking Slack again.
    const channel = await session.slack("POST", "/channels", { participants: [] });
    expect(channel.body.error).toBe("live_not_allowlisted");
    // The only call that reached Slack is the one that says which workspace the app is in.
    expect(stub.calls.map((call) => call.method)).toEqual(["auth.test"]);
  });

  test("an empty allowlist refuses every workspace", async () => {
    const stub = slackStub();
    const server = liveSlack(stub, "");
    const session = await server.open();
    expect((await session.slack("GET", "")).body.error).toBe("live_not_allowlisted");
    expect(stub.calls.map((call) => call.method)).toEqual(["auth.test"]);
  });

  test("a person's token from another workspace is refused", async () => {
    const stub = slackStub();
    const elsewhere = stub.person("ana", { team: "T0OTHER0001" });
    const session = await liveSlack(stub).open();
    const person = await session.slack("POST", "/users", { name: "Ana", token: elsewhere.token });
    expect(person.body.error).toBe("cross_workspace_credential");
    expect(stub.calls.filter((call) => call.method !== "auth.test")).toEqual([]);
  });
});

describe("live Slack: acting and reading back", () => {
  test("a real person asks in a channel and the agent's reply is read back", async () => {
    const stub = slackStub();
    const ana = stub.person("ana");
    const server = liveSlack(stub);
    const session = await server.open();

    const fixture = await session.slack("GET", "");
    // A live app's credentials stay on the server.
    expect(fixture.body.app).toMatchObject({
      botUserId: stub.bot.userId,
      botToken: "",
      signingSecret: "",
      appToken: "",
    });
    expect(fixture.body.apiUrl).toBe("https://slack.com/api/");
    expect(JSON.stringify(fixture.body)).not.toContain(stub.bot.token);
    // `channelstack env` has nothing for a live Slack: no fake URL, no fake or real token.
    const env = await server.call("GET", "/env");
    expect(Object.keys(env.body).filter((name) => name.startsWith("SLACK_"))).toEqual([]);

    const person = await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    expect(person.body).toMatchObject({ id: ana.userId, name: "ana", kind: "user" });
    expect(JSON.stringify(person.body)).not.toContain(ana.token);

    const channel = await session.slack("POST", "/channels", {
      name: "support",
      participants: [ana.userId, stub.bot.userId],
    });
    expect(channel.status).toBe(200);
    // Real names are unique in a workspace: the run's tag, a number, then the name the test asked for.
    expect(channel.body.name).toBe("channelstack-run-unit1-1-support");
    const created = stub.channel(channel.body.id);
    expect(created?.creator).toBe(ana.userId);
    expect([...(created?.members ?? [])].sort()).toEqual([ana.userId, stub.bot.userId].sort());

    // Through the API, Slack would mark Ana's message with the posting app's bot, and the agent
    // would ignore it: her message is typed in Slack's client, which the browser actor does.
    const said = await session.slack("POST", `/users/${ana.userId}/say`, {
      message: { text: "@my-agent summarize #support today" },
      channel: channel.body.id,
    });
    expect(said.status).toBe(422);
    expect(said.body).toMatchObject({
      error: "action_requires",
      data: { operation: "SlackUser.say", requires: "the browser actor" },
    });
    expect(said.body.message).toContain("channelstack login slack --user ana");
    expect(stub.calls.filter((call) => call.method === "chat.postMessage")).toEqual([]);

    // Here a stand-in types it, and the agent answers the way it would: Slack delivered to it.
    const asked = stub.typed(ana.userId, channel.body.id, `<@${stub.bot.userId}> summarize #support today`);
    stub.botSays(channel.body.id, "Here is today's summary", asked);
    const messages = await session.slack("GET", `/conversations/${channel.body.id}/messages`);
    expect(messages.body).toHaveLength(1);
    expect(messages.body[0]).toMatchObject({ ts: asked, author: { kind: "user", name: "ana" } });
    const replies = await session.slack("GET", `/conversations/${channel.body.id}/threads/${asked}/replies`);
    expect(replies.body).toHaveLength(1);
    expect(replies.body[0]).toMatchObject({
      text: "Here is today's summary",
      author: { kind: "app", name: "my-agent" },
    });

    const transcript = await session.slack("GET", `/conversations/${channel.body.id}/threads/${asked}/transcript`);
    expect(transcript.body.text).toContain("ana: @my-agent summarize #support today");
    expect(transcript.body.text).toContain("my-agent: Here is today's summary");
  });

  test("a fake person can't act in a live workspace", async () => {
    const stub = slackStub();
    const ana = stub.person("ana");
    const session = await liveSlack(stub).open();
    const real = await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    const ben = await session.slack("POST", "/users", { name: "Ben" });
    expect(ben.status).toBe(200);
    const channel = await session.slack("POST", "/channels", { participants: [real.body.id, ben.body.id] });
    expect(channel.body.error).toBe("fake_actor_in_live_world");
    const dm = await session.slack("POST", `/users/${ben.body.id}/open-dm`, { participants: [stub.bot.userId] });
    expect(dm.body.error).toBe("fake_actor_in_live_world");
  });

  test("CHANNELSTACK_REALITY=live refuses a person without a token", async () => {
    const stub = slackStub();
    const session = await liveSlack(stub, stub.team, { CHANNELSTACK_REALITY: "live" }).open();
    const ben = await session.slack("POST", "/users", { name: "Ben" });
    expect(ben.body.error).toBe("live_misconfigured");
    expect(ben.body.message).toContain("CHANNELSTACK_REALITY is live and Ben has no token");
  });

  test("a real account's role is Slack's: a test asking for another one is refused", async () => {
    const stub = slackStub();
    const ana = stub.person("ana");
    const ben = stub.person("ben", { admin: true });
    const session = await liveSlack(stub).open();
    const member = await session.slack("POST", "/users", { name: "Ana", token: ana.token, admin: true });
    expect(member.body.error).toBe("live_misconfigured");
    expect(member.body.message).toContain("Ana's account is not a workspace admin, but the test asks for admin: true");
    const admin = await session.slack("POST", "/users", { name: "Ben", token: ben.token, admin: true });
    expect(admin.status).toBe(200);
    expect(admin.body.isAdmin).toBe(true);
    const unasked = await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    expect(unasked.body.isAdmin).toBe(false);
  });

  test("a network error on the first check doesn't stick: the next action asks Slack again", async () => {
    const stub = slackStub();
    let failNext = true;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (failNext) {
        failNext = false;
        throw new TypeError("fetch failed");
      }
      return stub.fetch(input, init);
    }) as typeof fetch;
    const server = harness(
      {},
      {
        live: {
          env: {
            CHANNELSTACK_SLACK_APP_ID: "A0STUBAPP1",
            CHANNELSTACK_SLACK_BOT_TOKEN: stub.bot.token,
            CHANNELSTACK_LIVE_SLACK_TEAMS: stub.team,
          },
          fetch: flaky,
          apiBase: { slack: stub.apiBase },
        },
      },
    );
    const { body } = await server.call("POST", "/sessions", {});
    expect((await server.call("GET", `/sessions/${body.sessionId}/slack`)).status).toBe(500);
    expect((await server.call("GET", `/sessions/${body.sessionId}/slack`)).status).toBe(200);
  });

  test("a definitive refusal is kept: Slack isn't asked again", async () => {
    const stub = slackStub();
    const session = await liveSlack(stub, "T0SOMEWHERE").open();
    await session.slack("GET", "");
    await session.slack("GET", "");
    expect(stub.calls.map((call) => call.method)).toEqual(["auth.test"]);
  });

  test("a fixed id is refused live: real ids are Slack's", async () => {
    const stub = slackStub();
    const session = await liveSlack(stub).open();
    const fixed = await session.slack("POST", "/users", { name: "Ana", id: "U0FIXED0001" });
    expect(fixed.body.error).toBe("unsupported_in_live");
  });

  test("UI-only actions need the browser actor, and what only the agent's calls show needs proxy mode", async () => {
    const stub = slackStub();
    const ana = stub.person("ana");
    const session = await liveSlack(stub).open();
    await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    const before = stub.calls.length;

    const select = await session.slack("POST", `/users/${ana.userId}/select`, {
      option: ["staging"],
      menu: { label: "Environment" },
      message: { channel: "C0X", ts: "1.2" },
    });
    expect(select.status).toBe(422);
    expect(select.body).toMatchObject({
      error: "action_requires",
      data: { operation: "SlackUser.select", requires: "the browser actor" },
    });
    const status = await session.slack("GET", "/conversations/C0X/threads/1.2/state");
    expect(status.body).toMatchObject({ error: "action_requires", data: { requires: "proxy mode" } });
    const retry = await session.slack("POST", "/deliveries/E0X/retry", {});
    expect(retry.status).toBe(501);
    expect(retry.body.error).toBe("unsupported_in_live");
    expect(stub.calls.length).toBe(before);
  });
});

describe("the browser actor: what only Slack's client does", () => {
  test("a person signed in once types a message, with a real mention, and it is read back", async () => {
    const stub = slackStub();
    const ana = stub.person("ana");
    const server = liveSlack(stub);
    server.signIn("Ana", ana.userId);
    const session = await server.open();
    await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    const channel = await session.slack("POST", "/channels", { participants: [ana.userId, stub.bot.userId] });

    const said = await session.slack("POST", `/users/${ana.userId}/say`, {
      message: { text: "@my-agent summarize #support today" },
      channel: channel.body.id,
    });
    expect(said.status).toBe(200);
    expect(said.body).toMatchObject({ author: { kind: "user", name: "ana" } });
    // Typed in the client, not posted through the API: no app's bot on it, and a real mention.
    expect(stub.calls.filter((call) => call.method === "chat.postMessage")).toEqual([]);
    const typed = stub.channel(channel.body.id)?.messages.at(-1);
    expect(typed).toMatchObject({ user: ana.userId, text: `<@${stub.bot.userId}> summarize #support today` });
    expect(typed?.bot_id).toBeUndefined();
    // Its own origin first, to restore the session; then the conversation.
    expect(server.client.opened).toEqual([
      "https://app.slack.com",
      `https://app.slack.com/client/${stub.team}/${channel.body.id}`,
    ]);

    stub.botSays(channel.body.id, "Here you go", said.body.ts);
    const reply = await session.slack("POST", `/users/${ana.userId}/reply`, {
      message: { text: "thanks" },
      thread: { channel: channel.body.id, ts: said.body.ts },
    });
    expect(reply.body).toMatchObject({ text: "thanks", threadTs: said.body.ts });
  });

  test("R5.3: a typed message Slack stores escaped, with a link, is read back", async () => {
    const stub = slackStub();
    const ana = stub.person("ana");
    const server = liveSlack(stub);
    server.signIn("Ana", ana.userId);
    const session = await server.open();
    await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    const channel = await session.slack("POST", "/channels", { participants: [ana.userId, stub.bot.userId] });
    const said = await session.slack("POST", `/users/${ana.userId}/say`, {
      message: { text: "@my-agent ship a&b <now> per https://example.com/plan" },
      channel: channel.body.id,
    });
    expect(said.status).toBe(200);
    const typed = stub.channel(channel.body.id)?.messages.at(-1);
    expect(typed?.text).toBe(`<@${stub.bot.userId}> ship a&amp;b &lt;now&gt; per <https://example.com/plan>`);
    expect(said.body.ts).toBe(typed?.ts);
  });

  test("a click on the app's button, found by its label in the thread", async () => {
    const stub = slackStub();
    const ana = stub.person("ana");
    const server = liveSlack(stub);
    server.signIn("Ana", ana.userId);
    const session = await server.open();
    await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    const channel = await session.slack("POST", "/channels", { participants: [ana.userId, stub.bot.userId] });
    const asked = stub.typed(ana.userId, channel.body.id, "deploy web to staging");
    stub.botSays(channel.body.id, "Deploy web to staging?", asked, [
      {
        type: "actions",
        elements: [{ type: "button", action_id: "approve", text: { type: "plain_text", text: "Approve" } }],
      },
    ]);

    const clicked = await session.slack("POST", `/users/${ana.userId}/click`, {
      button: { actionId: "approve" },
      thread: { channel: channel.body.id, ts: asked },
    });
    expect(clicked.status).toBe(200);
    // Slack tells the agent itself: no delivery here.
    expect(clicked.body).toBeNull();
    expect(server.client.clicks).toEqual([
      { user: ana.userId, channel: channel.body.id, thread: asked, label: "Approve" },
    ]);
  });

  test("a saved session Slack has signed out is said as such, with how to sign in again", async () => {
    const stub = slackStub();
    const ana = stub.person("ana");
    const server = liveSlack(stub);
    server.signIn("Ana", SIGNED_OUT);
    const session = await server.open();
    await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    const channel = await session.slack("POST", "/channels", { participants: [ana.userId, stub.bot.userId] });
    const said = await session.slack("POST", `/users/${ana.userId}/say`, {
      message: { text: "hi" },
      channel: channel.body.id,
    });
    expect(said.body.error).toBe("live_misconfigured");
    expect(said.body.message).toBe(
      "Ana's saved Slack session is signed out: sign in again: channelstack login slack --user ana",
    );
    expect(stub.channel(channel.body.id)?.messages ?? []).toEqual([]);
    // A signed-out session isn't saved over the file: signing in again replaces it.
    await server.call("DELETE", `/sessions/${session.id}`);
    const kept = JSON.parse(readFileSync(storageStatePath(server.home, "slack", "Ana"), "utf8"));
    expect(kept.cookies).toEqual([{ name: "d", value: SIGNED_OUT, domain: ".slack.com" }]);
  });

  test("one browser for a person across sessions, and Slack's renewed cookies in every copy of their session", async () => {
    const stub = slackStub();
    const ana = stub.person("ana");
    const server = liveSlack(stub);
    server.signIn("Ana", ana.userId);
    // The test's own copy of the same session, as `channelstack login --save` writes it.
    const given = join(server.home, "ana-slack.json");
    writeStorageState(given, { cookies: [{ name: "d", value: ana.userId, domain: ".slack.com" }] });
    const sessions = [await server.open(), await server.open()];
    const channels: string[] = [];
    for (const session of sessions) {
      await session.slack("POST", "/users", { name: "Ana", token: ana.token, browser: { storageState: given } });
      channels.push(
        (await session.slack("POST", "/channels", { participants: [ana.userId, stub.bot.userId] })).body.id,
      );
    }
    // Both at once: one browser takes them one after the other, and neither's typing lands in the other's.
    const said = await Promise.all(
      sessions.map((session, at) =>
        session.slack("POST", `/users/${ana.userId}/say`, { message: { text: `hi ${at}` }, channel: channels[at] }),
      ),
    );
    expect(said.map((reply) => reply.body.text)).toEqual(["hi 0", "hi 1"]);
    expect(server.client.started.count).toBe(1);
    for (const session of sessions) await server.call("DELETE", `/sessions/${session.id}`);
    for (const path of [given, storageStatePath(server.home, "slack", "Ana")]) {
      expect(JSON.parse(readFileSync(path, "utf8")).cookies.map((cookie: { name: string }) => cookie.name)).toEqual([
        "d",
        "d-s",
      ]);
    }
  });

  test("a reply also sent to the channel isn't live yet, and says so", async () => {
    const stub = slackStub();
    const ana = stub.person("ana");
    const server = liveSlack(stub);
    server.signIn("Ana", ana.userId);
    const session = await server.open();
    await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    const channel = await session.slack("POST", "/channels", { participants: [ana.userId, stub.bot.userId] });
    const root = stub.typed(ana.userId, channel.body.id, "first");
    const reply = await session.slack("POST", `/users/${ana.userId}/reply`, {
      message: { text: "and the channel" },
      thread: { channel: channel.body.id, ts: root },
      alsoSendToChannel: true,
    });
    expect(reply.body).toMatchObject({ error: "unsupported_in_live" });
    expect(reply.body.message).toContain("Also send to #channel");
    expect(stub.channel(channel.body.id)?.messages).toHaveLength(1);
  });

  test("in a DM two sessions write in, each reads back what it typed, not the other's", async () => {
    const stub = slackStub();
    const ana = stub.person("ana");
    const server = liveSlack(stub);
    server.signIn("Ana", ana.userId);
    const sessions = [await server.open(), await server.open()];
    for (const session of sessions) await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    const said = await Promise.all(
      sessions.map((session, at) =>
        session.slack("POST", `/users/${ana.userId}/say`, {
          message: { text: at === 0 ? "deploy web" : "deploy api" },
          to: [stub.bot.userId],
        }),
      ),
    );
    expect(said.map((reply) => reply.status)).toEqual([200, 200]);
    expect(said.map((reply) => reply.body.text)).toEqual(["deploy web", "deploy api"]);
    expect(new Set(said.map((reply) => reply.body.ts)).size).toBe(2);
  });

  test("the cookies Slack renewed while the session was used are kept when it closes", async () => {
    const stub = slackStub();
    const ana = stub.person("ana");
    const server = liveSlack(stub);
    server.signIn("Ana", ana.userId);
    const session = await server.open();
    await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    const channel = await session.slack("POST", "/channels", { participants: [ana.userId, stub.bot.userId] });
    await session.slack("POST", `/users/${ana.userId}/say`, { message: { text: "hi" }, channel: channel.body.id });
    await server.call("DELETE", `/sessions/${session.id}`);
    const path = storageStatePath(server.home, "slack", "Ana");
    expect(JSON.parse(readFileSync(path, "utf8")).cookies).toEqual([
      { name: "d", value: ana.userId, domain: ".slack.com" },
      { name: "d-s", value: "2", domain: ".slack.com" },
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a saved session others can read, or none where the test said, is refused", async () => {
    const stub = slackStub();
    const ana = stub.person("ana");
    const ben = stub.person("ben");
    const server = liveSlack(stub);
    const session = await server.open();
    const shared = join(server.home, "shared.json");
    writeFileSync(shared, JSON.stringify({ cookies: [] }));
    chmodSync(shared, 0o644);
    await session.slack("POST", "/users", { name: "Ana", token: ana.token, browser: { storageState: shared } });
    const channel = await session.slack("POST", "/channels", { participants: [ana.userId] });
    const said = await session.slack("POST", `/users/${ana.userId}/say`, {
      message: { text: "hi" },
      channel: channel.body.id,
    });
    expect(said.body.error).toBe("live_misconfigured");
    expect(said.body.message).toContain("can be read by others");

    await session.slack("POST", "/users", {
      name: "Ben",
      token: ben.token,
      browser: { storageState: join(server.home, "nowhere.json") },
    });
    const benSays = await session.slack("POST", `/users/${ben.userId}/say`, {
      message: { text: "hi" },
      to: [stub.bot.userId],
    });
    expect(benSays.body.error).toBe("live_misconfigured");
    expect(benSays.body.message).toContain("No saved browser session");
  });
});

describe("exit check 5.2: cleanup leaves nothing behind", () => {
  test("closing the session archives its channels", async () => {
    const stub = slackStub();
    const ana = stub.person("ana");
    const server = liveSlack(stub);
    const session = await server.open();
    await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    const channel = await session.slack("POST", "/channels", { participants: [ana.userId, stub.bot.userId] });
    const closed = await server.call("DELETE", `/sessions/${session.id}`);
    expect(closed.status).toBe(204);
    expect(stub.channel(channel.body.id)?.archived).toBe(true);
  });

  test("the session's quiet can't be judged live without proxy mode", async () => {
    const stub = slackStub();
    const ana = stub.person("ana");
    const server = liveSlack(stub);
    const session = await server.open();
    await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    await session.slack("POST", "/channels", { participants: [ana.userId] });
    const quiet = await server.call("GET", `/sessions/${session.id}/quiet`);
    expect(quiet.body).toMatchObject({ error: "action_requires", data: { requires: "proxy mode" } });
  });
});
