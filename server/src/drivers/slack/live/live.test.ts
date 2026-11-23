import { describe, expect, test } from "vitest";

import { harness } from "../../../../test/app-harness.ts";
import { type SlackStub, slackStub } from "../../../../test/slack-live-stub.ts";

/** A server whose Slack driver is live against the stub: the app's credentials and the allowlist set, as in CI. */
function liveSlack(stub: SlackStub, allowlist = stub.team, extra: Record<string, string> = {}) {
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
      },
    },
  );
  const open = async () => {
    const { body } = await h.call("POST", "/sessions", {});
    return {
      id: body.sessionId as string,
      slack: (method: string, path: string, payload?: unknown) => h.call(method, `/sessions/${body.sessionId}/slack${path}`, payload),
    };
  };
  return { ...h, open };
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
    expect(fixture.body.app).toMatchObject({ botUserId: stub.bot.userId, botToken: "", signingSecret: "", appToken: "" });
    expect(fixture.body.apiUrl).toBe("https://slack.com/api/");
    expect(JSON.stringify(fixture.body)).not.toContain(stub.bot.token);

    const person = await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    expect(person.body).toMatchObject({ id: ana.userId, name: "ana", kind: "user" });
    expect(JSON.stringify(person.body)).not.toContain(ana.token);

    const channel = await session.slack("POST", "/channels", { name: "support", participants: [ana.userId, stub.bot.userId] });
    expect(channel.status).toBe(200);
    // Real names are unique in a workspace: the run's tag, a number, then the name the test asked for.
    expect(channel.body.name).toBe("channelstack-run-unit1-1-support");
    const created = stub.channel(channel.body.id);
    expect(created?.creator).toBe(ana.userId);
    expect([...(created?.members ?? [])].sort()).toEqual([ana.userId, stub.bot.userId].sort());

    const said = await session.slack("POST", `/users/${ana.userId}/say`, {
      message: { text: "@my-agent summarize #support today" },
      channel: channel.body.id,
    });
    expect(said.status).toBe(200);
    const post = stub.calls.find((call) => call.method === "chat.postMessage");
    // Ana's own token, and the app's name as a real mention of its bot.
    expect(post).toMatchObject({ as: "ana", params: { text: `<@${stub.bot.userId}> summarize #support today` } });
    expect(said.body.delivery).toBeUndefined();

    // Real Slack delivers to the agent; here it answers the way it would.
    stub.botSays(channel.body.id, "Here is today's summary", said.body.ts);
    server.clock.advance(1100);
    const replies = await session.slack("GET", `/conversations/${channel.body.id}/threads/${said.body.ts}/replies`);
    expect(replies.body).toHaveLength(1);
    expect(replies.body[0]).toMatchObject({ text: "Here is today's summary", author: { kind: "app", name: "my-agent" } });

    const transcript = await session.slack("GET", `/conversations/${channel.body.id}/threads/${said.body.ts}/transcript`);
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
    const dm = await session.slack("POST", `/users/${ben.body.id}/say`, { message: { text: "hi" }, to: [stub.bot.userId] });
    expect(dm.body.error).toBe("fake_actor_in_live_world");
  });

  test("a person's token issued by the agent's own app is refused: Slack would show their message as the app's", async () => {
    const stub = slackStub();
    const ana = stub.person("ana", { viaAgentApp: true });
    const server = liveSlack(stub);
    const session = await server.open();
    await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    const said = await session.slack("POST", `/users/${ana.userId}/say`, { message: { text: "hi" }, to: [stub.bot.userId] });
    expect(said.body).toMatchObject({ error: "action_requires", data: { requires: "a person's token from another Slack app" } });
    // What was posted is still removed with the session.
    await server.call("DELETE", `/sessions/${session.id}`);
    expect(stub.channels().flatMap((channel) => channel.messages)).toEqual([]);
  });

  test("CHANNELSTACK_REALITY=live refuses a person without a token", async () => {
    const stub = slackStub();
    const session = await liveSlack(stub, stub.team, { CHANNELSTACK_REALITY: "live" }).open();
    const ben = await session.slack("POST", "/users", { name: "Ben" });
    expect(ben.body).toMatchObject({ error: "action_requires", data: { requires: "a token" } });
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

    const click = await session.slack("POST", `/users/${ana.userId}/click`, { button: { label: "Approve" }, channel: "C0X" });
    expect(click.status).toBe(422);
    expect(click.body).toMatchObject({ error: "action_requires", data: { operation: "SlackUser.click", requires: "the browser actor" } });
    const status = await session.slack("GET", "/conversations/C0X/threads/1.2/state");
    expect(status.body).toMatchObject({ error: "action_requires", data: { requires: "proxy mode" } });
    const retry = await session.slack("POST", "/deliveries/E0X/retry", {});
    expect(retry.status).toBe(501);
    expect(retry.body.error).toBe("unsupported_in_live");
    expect(stub.calls.length).toBe(before);
  });
});

describe("exit check 5.2: cleanup leaves nothing behind", () => {
  test("closing the session archives its channels and deletes what was written in its DMs", async () => {
    const stub = slackStub();
    const ana = stub.person("ana");
    const server = liveSlack(stub);
    const session = await server.open();
    await session.slack("POST", "/users", { name: "Ana", token: ana.token });
    const channel = await session.slack("POST", "/channels", { participants: [ana.userId, stub.bot.userId] });
    const dm = await session.slack("POST", `/users/${ana.userId}/say`, {
      message: { text: "@my-agent are you there?" },
      to: [stub.bot.userId],
    });
    stub.botSays(dm.body.channel, "Yes", dm.body.ts);
    stub.botSays(dm.body.channel, "Anything else?");

    const closed = await server.call("DELETE", `/sessions/${session.id}`);
    expect(closed.status).toBe(204);
    expect(stub.channel(channel.body.id)?.archived).toBe(true);
    // Ana's message with her token, the agent's with the bot token: the DM is as it was.
    expect(stub.channel(dm.body.channel)?.messages).toEqual([]);
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
