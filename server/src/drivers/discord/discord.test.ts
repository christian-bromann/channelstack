import { verify } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { discordWorkspace, type TestGateway } from "../../../test/discord-workspace.ts";
import { DISCORD_IDS, discordSnowflake, snowflakeTime } from "./ids.ts";
import { botIdOf, DISCORD_SECRETS } from "./secrets.ts";
import { publicKeyOf, signInteraction } from "./signing.ts";

/**
 * The Discord fake as a bot meets it: REST v10's refusals, permissions and rate limits as Discord's,
 * the Gateway's handshake, intents and RESUME, and interactions with their 3 seconds. Every answer
 * and dispatch is held to Discord's own description (exit check 11.2).
 */
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const workspace = async (options: { interactions?: boolean } = {}) => {
  const space = await discordWorkspace(options);
  if (space.agent) closers.push(space.agent.close);
  return space;
};

describe("ids and secrets", () => {
  test("a snowflake made now has the time in it, and they grow", async () => {
    const { h } = await workspace();
    void h;
    const { IdGenerator } = await import("../../core/ids/index.ts");
    const ids = new IdGenerator({ seed: 1, clock: () => Date.parse("2026-11-26T12:00:00.000Z") });
    const first = discordSnowflake(ids);
    const second = discordSnowflake(ids);
    expect(BigInt(second) > BigInt(first)).toBe(true);
    expect(snowflakeTime(first)).toBe("2026-11-26T12:00:00.000Z");
    expect(ids.next(DISCORD_IDS.user)).toMatch(/^[1-9]\d{16,19}$/);
  });

  test("a bot token carries its bot's id, and the public key is the signing key's other half", () => {
    const token = DISCORD_SECRETS.botToken.generate();
    expect(botIdOf(token)).toMatch(/^[1-9]\d{17}$/);
    expect(botIdOf("not.a.token")).toBeUndefined();
    const seed = DISCORD_SECRETS.interactionsKey.generate();
    const headers = signInteraction(seed, '{"type":1}', 1_700_000_000_000);
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyOf(seed), "hex")]);
    expect(
      verify(
        null,
        Buffer.from(`${headers["x-signature-timestamp"]}{"type":1}`),
        { key: spki, format: "der", type: "spki" },
        Buffer.from(headers["x-signature-ed25519"] ?? "", "hex"),
      ),
    ).toBe(true);
  });
});

describe("REST v10 as Discord answers it", () => {
  test("a call without the bot's token is refused with Discord's 401, and an unknown route with its 404", async () => {
    const { api } = await workspace();
    expect(await api("GET", "/users/@me", undefined, null)).toEqual({
      status: 401,
      body: { message: "401: Unauthorized", code: 0 },
    });
    expect((await api("GET", "/users/@me", undefined, "Bot made-up")).status).toBe(401);
    expect(await api("GET", "/nothing/here")).toEqual({ status: 404, body: { message: "404: Not Found", code: 0 } });
  });

  test("the bot, its application and where the Gateway is", async () => {
    const { api, fixture } = await workspace();
    expect((await api("GET", `/guilds/${fixture.guild.id}`)).body).toMatchObject({
      id: fixture.guild.id,
      hub_type: null,
    });
    const me = await api("GET", "/users/@me");
    expect(me.body).toMatchObject({ id: fixture.app.botUserId, username: "my-agent", bot: true });
    const gateway = await api("GET", "/gateway/bot");
    expect(gateway.body).toMatchObject({ url: "ws://127.0.0.1:4500/discord/gateway", shards: 1 });
    expect((await api("GET", "/applications/@me")).body.verify_key).toBe(fixture.app.publicKey);
  });

  test("a message, a reply, an edit, a reaction and a thread, as the bot makes them", async () => {
    const { api, channel, say } = await workspace();
    const asked = await say("@my-agent hi");
    expect(asked.content).toMatch(/^<@\d+> hi$/);
    const reply = await api("POST", `/channels/${channel.id}/messages`, {
      content: "hello",
      message_reference: { message_id: asked.id },
    });
    expect(reply.body).toMatchObject({ type: 19, content: "hello", referenced_message: { id: asked.id } });
    const edited = await api("PATCH", `/channels/${channel.id}/messages/${reply.body.id}`, { content: "hello again" });
    expect(edited.body.edited_timestamp).not.toBeNull();
    expect(
      (await api("PUT", `/channels/${channel.id}/messages/${asked.id}/reactions/${encodeURIComponent("👀")}/@me`))
        .status,
    ).toBe(204);
    const thread = await api("POST", `/channels/${channel.id}/messages/${asked.id}/threads`, { name: "About hi" });
    expect(thread.status).toBe(201);
    expect(thread.body).toMatchObject({ id: asked.id, type: 11, parent_id: channel.id });
    const listed = await api("GET", `/channels/${channel.id}/messages?limit=10`);
    // Newest first, as Discord lists them.
    expect(listed.body.map((message: { id: string }) => message.id)).toEqual([reply.body.id, asked.id]);
    // What Discord refuses in a list's query: a limit outside 1 to 100, a cursor that isn't a snowflake.
    for (const [query, field, code] of [
      ["limit=101", "limit", "NUMBER_TYPE_MAX"],
      ["limit=0", "limit", "NUMBER_TYPE_MIN"],
      ["limit=abc", "limit", "NUMBER_TYPE_COERCE"],
      ["before=yesterday", "before", "NUMBER_TYPE_COERCE"],
      ["after=-1", "after", "NUMBER_TYPE_COERCE"],
    ] as const) {
      const refused = (await api("GET", `/channels/${channel.id}/messages?${query}`)).body;
      expect(refused.code, query).toBe(50035);
      expect(refused.errors[field]._errors[0].code, query).toBe(code);
    }
  });

  test("the 2000-character limit, an empty message, and a reply to nothing are refused as Discord refuses them", async () => {
    const { api, channel } = await workspace();
    expect(await api("POST", `/channels/${channel.id}/messages`, { content: "x".repeat(2001) })).toEqual({
      status: 400,
      body: {
        message: "Invalid Form Body",
        code: 50035,
        errors: {
          content: { _errors: [{ code: "BASE_TYPE_MAX_LENGTH", message: "Must be 2000 or fewer in length." }] },
        },
      },
    });
    expect((await api("POST", `/channels/${channel.id}/messages`, { content: " " })).body).toEqual({
      message: "Cannot send an empty message",
      code: 50006,
    });
    expect(
      (await api("POST", `/channels/${channel.id}/messages`, { content: "hi", message_reference: { message_id: "1" } }))
        .body.code,
    ).toBe(50035);
  });

  test("permissions: a channel the bot isn't in is 50001, a read-only one and someone else's message 50013", async () => {
    const { api, control, ana, say, channel } = await workspace();
    const hidden = (await control("POST", "/channels", { participants: [ana.id] })).body;
    expect((await api("GET", `/channels/${hidden.id}`)).body).toEqual({ message: "Missing Access", code: 50001 });
    const announcements = (
      await control("POST", "/channels", {
        participants: [ana.id, (await control("GET", "")).body.app.id],
        readOnly: true,
      })
    ).body;
    expect((await api("POST", `/channels/${announcements.id}/messages`, { content: "hi" })).body.code).toBe(50013);
    const hers = await say("my message");
    expect((await api("DELETE", `/channels/${channel.id}/messages/${hers.id}`)).body.code).toBe(50013);
    expect((await api("PATCH", `/channels/${channel.id}/messages/${hers.id}`, { content: "no" })).body.code).toBe(
      50005,
    );
    expect((await api("GET", `/channels/${channel.id}/messages/1`)).body).toEqual({
      message: "Unknown Message",
      code: 10008,
    });
  });

  test("rate limits: the sixth message in five seconds is a 429 with retry_after and the headers", async () => {
    const { api, channel, h } = await workspace();
    const replies = [];
    for (let i = 0; i < 6; i++)
      replies.push(
        await h.provider("POST", `discord/api/v10/channels/${channel.id}/messages`, { content: `m${i}` }, null, {
          authorization: `Bot ${h.secrets.get("discord", "botToken")}`,
        }),
      );
    expect(replies.slice(0, 5).map((reply) => reply.status)).toEqual([200, 200, 200, 200, 200]);
    expect(replies[5]?.status).toBe(429);
    expect(replies[5]?.body).toMatchObject({ message: "You are being rate limited.", global: false });
    expect(replies[5]?.body.retry_after).toBeGreaterThan(0);
    h.clock.advance(5000);
    expect((await api("POST", `/channels/${channel.id}/messages`, { content: "later" })).status).toBe(200);
  });

  test("a rate_limit fault refuses a route's next call, and the call is the test's", async () => {
    const { api, channel, control } = await workspace();
    const route = "POST /channels/{channel.id}/messages";
    await control("POST", "/faults", { type: "rate_limit", route, retryAfter: 1000, times: 1 });
    const refused = await api("POST", `/channels/${channel.id}/messages`, { content: "hi" });
    expect(refused.status).toBe(429);
    expect(refused.body.retry_after).toBe(1);
    expect((await api("POST", `/channels/${channel.id}/messages`, { content: "hi" })).status).toBe(200);
    const calls = (await control("GET", "/calls")).body as Array<{
      operation: string;
      responseStatus: number;
      error?: string;
    }>;
    expect(calls.filter((call) => call.operation === route).map((call) => call.responseStatus)).toEqual([429, 200]);
  });
});

describe("the Gateway", () => {
  test("HELLO, then IDENTIFY: READY and the guild, with sequence numbers", async () => {
    const { identify, fixture, control } = await workspace();
    const gateway = await identify();
    expect(gateway.received[0]).toMatchObject({ op: 10, d: { heartbeat_interval: 41_250 } });
    const [ready, guild] = gateway.dispatches();
    expect(ready).toMatchObject({
      t: "READY",
      s: 1,
      d: { v: 10, user: { id: fixture.app.botUserId }, guilds: [{ id: fixture.guild.id, unavailable: true }] },
    });
    expect(ready?.d.resume_gateway_url).toBe("ws://127.0.0.1:4500/discord/gateway");
    // READY's application is its id and flags, the flags also as a string (`flags_new`).
    expect(ready?.d.application).toEqual({
      id: fixture.app.id,
      flags: expect.any(Number),
      flags_new: String(ready?.d.application.flags),
    });
    expect(guild).toMatchObject({ t: "GUILD_CREATE", s: 2, d: { id: fixture.guild.id, unavailable: false } });
    // The guild object, here and from REST, has every field discord-api-types' `APIGuild` requires: `hub_type` among them.
    expect(guild?.d.hub_type).toBeNull();
    gateway.send({ op: 1, d: 2 });
    expect(gateway.received.at(-1)).toEqual({ op: 11 });
    expect((await control("GET", "")).body.gatewayConnections).toBe(1);
  });

  test("a bad token is 4004, intents that don't exist 4013, a privileged intent the app lacks 4014", async () => {
    const { connect, token } = await workspace();
    const cases: Array<[unknown, number]> = [
      [{ token: "made-up", intents: 1 }, 4004],
      [{ token, intents: 1 << 30 }, 4013],
      [{ token, intents: 1 << 8 }, 4014],
    ];
    for (const [d, code] of cases) {
      const gateway = await connect();
      gateway.send({ op: 2, d });
      expect(gateway.closed?.code).toBe(code);
    }
    const garbled = await connect();
    garbled.send("not json");
    expect(garbled.closed?.code).toBe(4002);
    const early = await connect();
    early.send({ op: 3, d: {} });
    expect(early.closed?.code).toBe(4003);
    expect((await connect("?v=10&encoding=etf")).closed?.code).toBe(4012);
  });

  test("a person's message is MESSAGE_CREATE, with its content only with MESSAGE_CONTENT", async () => {
    const { identify, say } = await workspace();
    const gateway = await identify();
    await say("plain words");
    await say("@my-agent a mention");
    const created = gateway.dispatches().filter((payload) => payload.t === "MESSAGE_CREATE");
    expect(created.map((payload) => payload.d.content)).toEqual([
      "plain words",
      expect.stringMatching(/^<@\d+> a mention$/),
    ]);
    expect(created[0]?.d).toMatchObject({
      guild_id: expect.any(String),
      member: { roles: [] },
      author: { username: "ana" },
    });
    // In a guild, each mentioned user comes with their partial member, as Discord's Gateway sends it.
    expect(created[1]?.d.mentions).toEqual([
      expect.objectContaining({ bot: true, member: expect.objectContaining({ roles: [expect.any(String)] }) }),
    ]);

    const { identify: again, say: sayAgain } = await workspace();
    // Without the intent, a guild message's content is empty unless it mentions the bot.
    const without = await again((1 << 0) | (1 << 9));
    await sayAgain("plain words");
    await sayAgain("@my-agent a mention");
    const contents = without
      .dispatches()
      .filter((payload) => payload.t === "MESSAGE_CREATE")
      .map((payload) => payload.d.content);
    expect(contents).toEqual(["", expect.stringMatching(/a mention$/)]);
  });

  test("a channel the bot can see arrives as CHANNEL_CREATE; one it is invited to as CHANNEL_UPDATE", async () => {
    const { identify, control, ana, fixture } = await workspace();
    const gateway = await identify();
    const admin = (await control("POST", "/users", { name: "Cara", admin: true })).body;
    const seen = (await control("POST", "/channels", { participants: [ana.id, fixture.app.id] })).body;
    const hidden = (await control("POST", "/channels", { participants: [admin.id] })).body;
    await control("POST", `/users/${admin.id}/invite`, { participants: [fixture.app.id], channel: hidden.id });
    const events = gateway
      .dispatches()
      .filter((payload) => payload.t.startsWith("CHANNEL_") && [seen.id, hidden.id].includes(payload.d.id));
    expect(events.map((payload) => [payload.t, payload.d.id])).toEqual([
      ["CHANNEL_CREATE", seen.id],
      ["CHANNEL_UPDATE", hidden.id],
    ]);
  });

  test("RESUME after a drop replays what the bot missed, once; an unknown session is INVALID_SESSION", async () => {
    const { identify, connect, say, token, control } = await workspace();
    const first = await identify();
    const before = first.dispatches();
    const ready = before[0];
    const seen = before.at(-1)?.s ?? 0;
    await control("POST", "/faults", { type: "drop_gateway" });
    await say("while you were away");
    // The connection dropped just before the message reached the bot.
    expect(first.closed).toEqual({ code: null });
    expect(first.dispatches().some((payload) => payload.t === "MESSAGE_CREATE")).toBe(false);

    const second = await connect();
    second.send({ op: 6, d: { token, session_id: ready?.d.session_id, seq: seen } });
    const replayed = second.dispatches();
    expect(replayed.map((payload) => [payload.t, payload.s])).toEqual([
      ["MESSAGE_CREATE", seen + 1],
      ["RESUMED", seen + 2],
    ]);

    const third = await connect();
    third.send({ op: 6, d: { token, session_id: "0".repeat(32), seq: 1 } });
    expect(third.received.at(-1)).toEqual({ op: 9, d: false });
  });
});

describe("faults", () => {
  test("each session's drop is its own: it fires before that session's next dispatch, and undo takes it back", async () => {
    const { identify, control, say, h, fixture } = await workspace();
    const gateway = await identify();
    // A second test session on the same server, with a person of its own.
    const other = (await h.call("POST", "/sessions")).body.sessionId as string;
    const otherControl = (method: string, path: string, body?: unknown) =>
      h.call(method, `/sessions/${other}/discord${path}`, body);
    const ben = (await otherControl("POST", "/users", { name: "Ben" })).body;

    await control("POST", "/faults", { type: "drop_gateway" });
    const undone = (await otherControl("POST", "/faults", { type: "drop_gateway" })).body;
    await otherControl("DELETE", `/faults/${undone.id}`);

    // Ben's session undid its drop: his message arrives, and the connection stays up.
    await otherControl("POST", `/users/${ben.id}/say`, { text: { content: "from Ben" }, to: [fixture.app.id] });
    await h.app.settled();
    expect(gateway.closed).toBeUndefined();
    expect(gateway.dispatches().some((payload) => payload.d?.content === "from Ben")).toBe(true);

    // Ana's session's drop fires before its next dispatch, once.
    await say("from Ana");
    await h.app.settled();
    expect(gateway.closed).toEqual({ code: null });
    expect(gateway.dispatches().some((payload) => payload.d?.content === "from Ana")).toBe(false);
  });
});

describe("interactions", () => {
  /** The app's commands, registered the way discord.js does at start. */
  const register = async (space: Awaited<ReturnType<typeof workspace>>) => {
    const { api, fixture } = space;
    const saved = await api("PUT", `/applications/${fixture.app.id}/guilds/${fixture.guild.id}/commands`, [
      {
        name: "deploy",
        description: "Deploy",
        options: [{ type: 3, name: "service", description: "What", required: true }],
      },
      {
        name: "assign",
        description: "Assign",
        options: [{ type: 6, name: "person", description: "Who", required: true }],
      },
    ]);
    expect(saved.body).toMatchObject([
      { name: "deploy", application_id: fixture.app.id, version: expect.any(String) },
      { name: "assign" },
    ]);
  };

  test("over HTTP: signed with the app's key, the response in the body, the message in the channel", async () => {
    const space = await workspace({ interactions: true });
    await register(space);
    const { agent, control, ana, channel, h, fixture } = space;
    if (!agent) throw new Error("no agent");
    agent.respond = () => ({ status: 200, body: JSON.stringify({ type: 4, data: { content: "Deploying web." } }) });
    const delivery = (
      await control("POST", `/users/${ana.id}/commands`, { command: "/deploy web", channel: channel.id })
    ).body;
    await h.app.settled();
    const [received] = agent.received;
    const body = JSON.parse(received?.body ?? "{}");
    expect(body).toMatchObject({
      type: 2,
      data: { name: "deploy", options: [{ name: "service", type: 3, value: "web" }] },
      channel_id: channel.id,
      member: { user: { id: ana.id } },
    });
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(fixture.app.publicKey, "hex"),
    ]);
    const signed = `${received?.headers["x-signature-timestamp"]}${received?.body}`;
    expect(
      verify(
        null,
        Buffer.from(signed),
        { key: spki, format: "der", type: "spki" },
        Buffer.from(String(received?.headers["x-signature-ed25519"]), "hex"),
      ),
    ).toBe(true);
    expect(delivery).toMatchObject({ type: "INTERACTION_CREATE", channel: "discord" });
    const transcript = (await control("GET", `/channels/${channel.id}/transcript`)).body;
    expect(transcript.text).toBe("my-agent: Deploying web.");
  });

  test('not answered within 3 seconds, a person sees "This interaction failed" and the callback is 10062', async () => {
    const space = await workspace();
    await register(space);
    const { control, ana, channel, h, identify, api } = space;
    const gateway = await identify();
    await control("POST", `/users/${ana.id}/commands`, { command: "/deploy web", channel: channel.id });
    await h.app.settled();
    const interaction = gateway.dispatches().find((payload) => payload.t === "INTERACTION_CREATE")?.d;
    h.clock.advance(3001);
    h.timers.advance(3001);
    const late = await api(
      "POST",
      `/interactions/${interaction.id}/${interaction.token}/callback`,
      { type: 4, data: { content: "too late" } },
      null,
    );
    expect(late.body).toEqual({ message: "Unknown interaction", code: 10062 });
    const seen = (await control("GET", `/channels/${channel.id}/transcript?as=${ana.id}`)).body;
    expect(seen.text).toBe("my-agent: This interaction failed (only Ana sees this)");
    expect((await control("GET", `/channels/${channel.id}/transcript`)).body.text).toBe("");
  });

  test("a callback in time is the response; a second one is 40060", async () => {
    const space = await workspace();
    await register(space);
    const { control, ana, channel, h, identify, api } = space;
    const gateway = await identify();
    await control("POST", `/users/${ana.id}/commands`, { command: "/deploy web", channel: channel.id });
    await h.app.settled();
    const interaction = gateway.dispatches().find((payload) => payload.t === "INTERACTION_CREATE")?.d;
    const path = `/interactions/${interaction.id}/${interaction.token}/callback`;
    expect((await api("POST", path, { type: 5 }, null)).status).toBe(204);
    expect((await control("GET", `/channels/${channel.id}/transcript`)).body.text).toBe(
      "my-agent: my-agent is thinking…",
    );
    expect((await api("POST", path, { type: 4, data: { content: "again" } }, null)).body.code).toBe(40060);
    const edited = await api(
      "PATCH",
      `/webhooks/${space.fixture.app.id}/${interaction.token}/messages/@original`,
      { content: "Done." },
      null,
    );
    expect(edited.body.content).toBe("Done.");
    expect((await control("GET", `/channels/${channel.id}/transcript`)).body.text).toBe("my-agent: Done. (edited)");
  });

  test("Discord's endpoint check: a PING answered with a PONG, and a forged one refused", async () => {
    const space = await workspace({ interactions: true });
    const { agent, control } = space;
    if (!agent) throw new Error("no agent");
    agent.respond = (delivery) => {
      const forged = JSON.parse(delivery.body) && agent.received.length > 1;
      return forged ? { status: 401, body: "invalid" } : { status: 200, body: '{"type":1}' };
    };
    expect((await control("POST", "/verify-endpoint")).body).toMatchObject({ valid: true, problems: [] });
    agent.respond = () => ({ status: 200, body: '{"type":1}' });
    expect((await control("POST", "/verify-endpoint")).body.problems).toEqual([
      "A PING with a bad signature got 200, not 401",
    ]);
  });

  /** A slash command over the Gateway: its interaction, as the bot reads it. */
  const commanded = async (space: Awaited<ReturnType<typeof workspace>>, gateway: TestGateway, command: string) => {
    const { control, ana, channel, h } = space;
    const before = gateway.dispatches().length;
    const reply = await control("POST", `/users/${ana.id}/commands`, { command, channel: channel.id });
    await h.app.settled();
    return {
      reply,
      interaction: gateway
        .dispatches()
        .slice(before)
        .find((payload) => payload.t === "INTERACTION_CREATE")?.d,
    };
  };

  test("a USER option comes with the person in `resolved`; one that names nobody is refused", async () => {
    const space = await workspace();
    await register(space);
    const gateway = await space.identify();
    const { interaction } = await commanded(space, gateway, "/assign @Ana");
    expect(interaction.data.options).toEqual([{ name: "person", type: 6, value: space.ana.id }]);
    expect(interaction.data.resolved.users[space.ana.id]).toMatchObject({ id: space.ana.id, username: "ana" });
    expect(interaction.data.resolved.members[space.ana.id]).toMatchObject({ roles: [] });
    const { reply } = await commanded(space, gateway, "/assign @nobody");
    expect(reply.body.error).toBe("invalid_argument");
  });

  test("one content check for every message: a callback's is under `data`, a followup's isn't, and 10 embeds at most", async () => {
    const space = await workspace();
    await register(space);
    const gateway = await space.identify();
    const { interaction } = await commanded(space, gateway, "/deploy web");
    const callback = `/interactions/${interaction.id}/${interaction.token}/callback`;
    const tooLong = { type: 4, data: { content: "x".repeat(2001) } };
    expect((await space.api("POST", callback, tooLong, null)).body.errors).toHaveProperty("data.content._errors");
    // In time, deferred, and the response says it is loading.
    const deferred = await space.api("POST", `${callback}?with_response=true`, { type: 5 }, null);
    expect(deferred.body.interaction.response_message_loading).toBe(true);
    const webhook = `/webhooks/${space.fixture.app.id}/${interaction.token}`;
    const followup = await space.api("POST", webhook, { content: "x".repeat(2001) }, null);
    expect(followup.body.errors).toHaveProperty("content._errors");
    const embeds = await space.api(
      "POST",
      webhook,
      { embeds: Array.from({ length: 11 }, () => ({ title: "t" })) },
      null,
    );
    expect(embeds.body.errors).toHaveProperty("embeds._errors");
    const edit = await space.api("PATCH", `${webhook}/messages/@original`, { content: "x".repeat(2001) }, null);
    expect(edit.body.errors).toHaveProperty("content._errors");
  });

  test("a private thread isn't made public: it is refused", async () => {
    const { api, channel } = await workspace();
    const refused = await api("POST", `/channels/${channel.id}/threads`, { name: "secret", type: 12 });
    expect(refused.body).toMatchObject({ code: 50035, errors: { type: expect.anything() } });
    expect((await api("POST", `/channels/${channel.id}/threads`, { name: "open", type: 11 })).status).toBe(201);
  });
});
