import { describe, expect, test } from "vitest";

import { harness } from "../../../../test/app-harness.ts";
import { type DiscordStub, discordStub } from "../../../../test/discord-live-stub.ts";
import { discordMaintenance } from "./maintenance.ts";

/** A server whose Discord driver is live against the stub: the bot's token and the allowlist set, as in CI. */
function liveDiscord(stub: DiscordStub, allowlist = stub.guild, more: Record<string, string> = {}) {
  const env = {
    CHANNELSTACK_DISCORD_BOT_TOKEN: stub.bot.token,
    CHANNELSTACK_LIVE_DISCORD_GUILDS: allowlist,
    CHANNELSTACK_RUN_ID: "unit1",
    ...more,
  };
  const h = harness({}, { live: { env, fetch: stub.fetch, apiBase: { discord: stub.apiBase } } });
  const open = async () => {
    const { body } = await h.call("POST", "/sessions", {});
    return {
      id: body.sessionId as string,
      discord: (method: string, path: string, payload?: unknown) =>
        h.call(method, `/sessions/${body.sessionId}/discord${path}`, payload),
    };
  };
  return { ...h, open, env };
}

describe("live Discord", () => {
  test("a guild outside CHANNELSTACK_LIVE_DISCORD_GUILDS is refused before anything is done there", async () => {
    const stub = discordStub();
    const server = liveDiscord(stub, "1999999999999999999");
    const session = await server.open();
    const refused = await session.discord("POST", "/channels", { participants: [] });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("live_not_allowlisted");
    expect(stub.calls.map((call) => call.path)).toEqual([
      "/users/@me",
      "/oauth2/applications/@me",
      "/users/@me/guilds",
    ]);
  });

  test("a failure of Discord's own on the first check isn't kept: the next action asks again", async () => {
    const stub = discordStub();
    let failures = 1;
    // Cloudflare in front of the API answers a 502 as HTML, once.
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/users/@me") && failures-- > 0)
        return new Response("<html>502</html>", { status: 502 });
      return stub.fetch(input, init);
    }) as typeof fetch;
    const session = await liveDiscord({ ...stub, fetch: flaky }).open();
    const first = await session.discord("GET", "");
    expect(first.status).toBe(409);
    expect(first.body.error).toBe("http_502");
    const second = await session.discord("GET", "");
    expect(second.status).toBe(200);
    expect(second.body.guild.id).toBe(stub.guild);
  });

  test("live, channelstack env prints nothing for Discord: the bot's token stays in the server", async () => {
    const server = liveDiscord(discordStub());
    const env = (await server.call("GET", "/env")).body as Record<string, string>;
    expect(Object.keys(env).filter((key) => key.startsWith("DISCORD_"))).toEqual([]);
  });

  test("the fixture names the real bot, and never its token", async () => {
    const stub = discordStub();
    const session = await liveDiscord(stub).open();
    const fixture = (await session.discord("GET", "")).body;
    expect(fixture.app).toMatchObject({ id: stub.bot.id, botUserId: stub.bot.id, botToken: "", publicKey: "" });
    expect(fixture.apiUrl).toBe("https://discord.com/api");
    expect(fixture.guild.id).toBe(stub.guild);
  });

  test("a bot with its own name in the guild is still `my-agent` to the tests, and so are its replies", async () => {
    const stub = discordStub({ botName: "Robin" });
    const ana = stub.person("ana");
    stub.agentReplies(() => "On it.");
    const session = await liveDiscord(stub).open();
    const fixture = (await session.discord("GET", "")).body;
    expect(fixture.app.name).toBe("my-agent");
    const person = (await session.discord("POST", "/users", { name: "Ana", token: ana.token })).body;
    const channel = (await session.discord("POST", "/channels", { participants: [person.id, fixture.app.id] })).body;
    const msg = (
      await session.discord("POST", `/users/${person.id}/say`, {
        text: { content: "@my-agent hi" },
        channel: channel.id,
      })
    ).body;
    // Mentioning the app by the tests' name mentions the real bot.
    expect(msg.content).toBe(`<@${stub.bot.id}> hi`);
    const replies = (await session.discord("GET", `/channels/${channel.id}/messages/${msg.id}/replies`)).body;
    expect(replies.map((reply: { author: { name: string } }) => reply.author.name)).toEqual(["my-agent"]);
  });

  test("a person's bot writes through the API, the agent answers from Discord, and both are read back", async () => {
    const stub = discordStub();
    const ana = stub.person("ana");
    stub.agentReplies((message) =>
      message.content.includes(`<@${stub.bot.id}>`) ? "Here's what I found." : undefined,
    );
    const server = liveDiscord(stub);
    const session = await server.open();
    const fixture = (await session.discord("GET", "")).body;
    const person = (await session.discord("POST", "/users", { name: "Ana", token: ana.token })).body;
    expect(person).toMatchObject({ id: ana.id, username: "ana", isAdmin: false });
    expect(JSON.stringify(person)).not.toContain(ana.token);

    const channel = (await session.discord("POST", "/channels", { participants: [person.id, fixture.app.id] })).body;
    const made = stub.calls.find((call) => call.method === "POST" && call.path === `/guilds/${stub.guild}/channels`)
      ?.body as { name: string; permission_overwrites: Array<{ id: string }> };
    // Private to its participants, tagged with the run, made by the agent's bot.
    expect(made.name).toMatch(/^channelstack-run-unit1-[a-z]{4}-1$/);
    expect(made.permission_overwrites.map((each) => each.id)).toEqual([stub.guild, stub.bot.id, ana.id]);

    const msg = (
      await session.discord("POST", `/users/${person.id}/say`, {
        text: { content: "@my-agent what broke?" },
        channel: channel.id,
      })
    ).body;
    expect(msg).toMatchObject({
      content: `<@${stub.bot.id}> what broke?`,
      text: "@my-agent what broke?",
      author: { id: ana.id },
    });
    // Ana's message went out as her bot, with her bot's token.
    expect(
      stub.calls.find((call) => call.path === `/channels/${channel.id}/messages` && call.method === "POST")?.by,
    ).toBe("ana");
    const replies = (await session.discord("GET", `/channels/${channel.id}/messages/${msg.id}/replies`)).body;
    expect(replies.map((reply: { author: { kind: string }; text: string }) => [reply.author.kind, reply.text])).toEqual(
      [["app", "Here's what I found."]],
    );

    // A read-only channel: nobody but an admin writes or reacts there, the bot included, as in the fake.
    await session.discord("POST", "/channels", { participants: [person.id, fixture.app.id], readOnly: true });
    const readOnly = stub.calls
      .filter((call) => call.method === "POST" && call.path === `/guilds/${stub.guild}/channels`)
      .at(-1)?.body as { permission_overwrites: Array<{ id: string; allow: string; deny: string }> };
    const [everyone, botOverwrite, anaOverwrite] = readOnly.permission_overwrites;
    const SEND = 1n << 11n;
    const REACT = 1n << 6n;
    expect(BigInt(everyone?.deny ?? "0") & (SEND | REACT)).toBe(SEND | REACT);
    for (const overwrite of [botOverwrite, anaOverwrite])
      expect(BigInt(overwrite?.allow ?? "0") & (SEND | REACT)).toBe(0n);

    // The session's channel goes when the session does, messages and all.
    await server.call("DELETE", `/sessions/${session.id}`);
    expect(stub.channels.has(channel.id)).toBe(false);
  });

  test("a person replies, edits, reacts, starts a thread and deletes, each as their bot", async () => {
    const stub = discordStub();
    const ana = stub.person("ana");
    const session = await liveDiscord(stub).open();
    const fixture = (await session.discord("GET", "")).body;
    await session.discord("POST", "/users", { name: "Ana", token: ana.token });
    const channel = (await session.discord("POST", "/channels", { participants: [ana.id, fixture.app.id] })).body;
    const said = (
      await session.discord("POST", `/users/${ana.id}/say`, { text: { content: "first" }, channel: channel.id })
    ).body;
    const message = { channelId: channel.id, id: said.id };

    const reply = (await session.discord("POST", `/users/${ana.id}/reply`, { text: { content: "and more" }, message }))
      .body;
    expect(reply).toMatchObject({ text: "and more", author: { id: ana.id } });
    const edited = (await session.discord("POST", `/users/${ana.id}/edit`, { text: { content: "fixed" }, message }))
      .body;
    expect(edited.text).toBe("fixed");
    expect((await session.discord("POST", `/users/${ana.id}/react`, { emoji: "👍", message })).body).toBeNull();
    const reactions = () => session.discord("GET", `/channels/${channel.id}/messages/${said.id}/reactions`);
    expect((await reactions()).body).toMatchObject([{ emoji: "👍", by: [{ id: ana.id, kind: "user" }] }]);
    await session.discord("POST", `/users/${ana.id}/unreact`, { emoji: "👍", message });
    expect((await reactions()).body).toEqual([]);

    const thread = (await session.discord("POST", `/users/${ana.id}/threads`, { name: "triage", message })).body;
    expect(thread).toMatchObject({ name: "triage" });
    expect(
      (await session.discord("GET", `/channels/${channel.id}/threads`)).body.map((each: { id: string }) => each.id),
    ).toEqual([thread.id]);

    await session.discord("POST", `/users/${ana.id}/delete`, { message: { channelId: channel.id, id: reply.id } });
    expect(stub.channels.get(channel.id)?.messages.map((each) => each.id)).not.toContain(reply.id);
    expect(
      stub.calls
        .filter((call) => call.path.startsWith(`/channels/${channel.id}/messages`) && call.method !== "GET")
        .map((call) => call.by),
    ).toEqual(["ana", "ana", "ana", "ana", "ana", "ana", "ana"]);
  });

  test("a thread in a channel, and inviting someone, are the person's bot's and the agent's bot's", async () => {
    const stub = discordStub();
    const ana = stub.person("ana");
    const ben = stub.person("ben");
    const session = await liveDiscord(stub).open();
    const fixture = (await session.discord("GET", "")).body;
    await session.discord("POST", "/users", { name: "Ana", token: ana.token });
    await session.discord("POST", "/users", { name: "Ben", token: ben.token });
    const channel = (await session.discord("POST", "/channels", { participants: [ana.id, fixture.app.id] })).body;

    const thread = (await session.discord("POST", `/users/${ana.id}/threads`, { name: "plans", channel: channel.id }))
      .body;
    expect(thread).toMatchObject({ name: "plans" });
    expect(stub.calls.find((call) => call.path === `/channels/${channel.id}/threads`)).toMatchObject({
      method: "POST",
      by: "ana",
      body: { name: "plans", type: 11 },
    });

    // The agent's bot made the channel, so it lets Ben in: a person's bot may not change overwrites.
    await session.discord("POST", `/users/${ana.id}/invite`, { participants: [ben.id], channel: channel.id });
    expect(stub.calls.find((call) => call.path === `/channels/${channel.id}/permissions/${ben.id}`)).toMatchObject({
      method: "PUT",
      by: "app",
      body: { type: 1 },
    });
    expect(stub.channels.get(channel.id)?.permission_overwrites?.map((each) => each.id)).toContain(ben.id);
  });

  test("a person's admin is their bot's roles in the guild", async () => {
    const stub = discordStub();
    const ana = stub.person("ana");
    const ada = stub.person("ada", { admin: true });
    const session = await liveDiscord(stub).open();
    expect(
      (await session.discord("POST", "/users", { name: "Ada", token: ada.token, admin: true })).body,
    ).toMatchObject({ id: ada.id, isAdmin: true });
    const notAdmin = (await session.discord("POST", "/users", { name: "Ana", token: ana.token, admin: true })).body;
    expect(notAdmin.error).toBe("live_misconfigured");
  });

  test("with CHANNELSTACK_REALITY=live, a person without a token is refused, not made fake", async () => {
    const stub = discordStub();
    const session = await liveDiscord(stub, stub.guild, { CHANNELSTACK_REALITY: "live" }).open();
    expect((await session.discord("POST", "/users", { name: "Cara" })).body).toMatchObject({
      error: "live_misconfigured",
      message: expect.stringContaining("CHANNELSTACK_DISCORD_USER_<NAME>_TOKEN"),
    });
  });

  test("a token that isn't a second bot in the guild, and a fake person, are each said as such", async () => {
    const stub = discordStub();
    const away = stub.person("away", { outside: true });
    const human = stub.person("human", { human: true });
    const server = liveDiscord(stub);
    const session = await server.open();
    const fixture = (await session.discord("GET", "")).body;
    const own = (await session.discord("POST", "/users", { name: "Ana", token: stub.bot.token })).body;
    expect(own).toMatchObject({ error: "live_misconfigured", message: expect.stringContaining("agent's own bot") });
    const outside = (await session.discord("POST", "/users", { name: "Away", token: away.token })).body;
    expect(outside).toMatchObject({ error: "live_misconfigured", message: expect.stringContaining("sandbox guild") });
    const notBot = (await session.discord("POST", "/users", { name: "Hu", token: human.token })).body;
    expect(notBot).toMatchObject({
      error: "live_misconfigured",
      message: expect.stringContaining("Hu's token isn't a bot's"),
    });
    expect(JSON.stringify([own, outside, notBot])).not.toContain(away.token);
    expect(JSON.stringify([own, outside, notBot])).not.toContain(human.token);

    const cara = (await session.discord("POST", "/users", { name: "Cara" })).body;
    expect((await session.discord("POST", "/channels", { participants: [cara.id, fixture.app.id] })).body.error).toBe(
      "fake_actor_in_live_world",
    );
  });

  test("what isn't built live, or has no live counterpart, says so", async () => {
    const stub = discordStub();
    const ana = stub.person("ana");
    const session = await liveDiscord(stub).open();
    const fixture = (await session.discord("GET", "")).body;
    await session.discord("POST", "/users", { name: "Ana", token: ana.token });
    expect((await session.discord("POST", "/users", { name: "Bot", bot: true })).body.error).toBe(
      "unsupported_in_live",
    );
    expect((await session.discord("POST", "/users", { name: "Ben", id: "1100000000000000777" })).body.error).toBe(
      "unsupported_in_live",
    );
    expect((await session.discord("POST", "/channels", { participants: [ana.id] })).body.error).toBe(
      "unsupported_in_live",
    );
    // A person is a bot live: Discord lets no bot DM another, run a command or press a button.
    const channel = (await session.discord("POST", "/channels", { participants: [ana.id, fixture.app.id] })).body;
    const refused = [
      await session.discord("POST", `/users/${ana.id}/say`, { text: { content: "hi" }, to: [fixture.app.id] }),
      await session.discord("POST", `/users/${ana.id}/open-dm`, { participant: fixture.app.id }),
      await session.discord("POST", `/users/${ana.id}/commands`, { command: "/deploy web", channel: channel.id }),
      await session.discord("POST", `/users/${ana.id}/click`, { button: { label: "Approve" }, channel: channel.id }),
    ];
    expect(refused.map((each) => each.body.error)).toEqual(Array(4).fill("unsupported_in_live"));
    expect((await session.discord("POST", "/faults", { type: "drop_gateway" })).body.error).toBe("unsupported_in_live");
    expect((await session.discord("POST", "/verify-endpoint")).body.error).toBe("unsupported_in_live");
    expect((await session.discord("GET", "/deliveries")).body.error).toBe("unsupported_in_live");
  });

  test("doctor names the bot, its guild and its intents; sweep removes what a crashed run tagged", async () => {
    const stub = discordStub();
    const env = { CHANNELSTACK_DISCORD_BOT_TOKEN: stub.bot.token, CHANNELSTACK_LIVE_DISCORD_GUILDS: stub.guild };
    const timers = {
      after: (_ms: number, run: () => void) => {
        run();
        return () => {};
      },
    };
    const lines = await discordMaintenance.doctor({ env, fetch: stub.fetch, timers, apiBase: stub.apiBase });
    expect(lines).toEqual([{ ok: true, text: expect.stringContaining(`guild ${stub.guild} (MESSAGE_CONTENT)`) }]);
    expect(lines[0]?.text).not.toContain(stub.bot.token);

    // A person's bot is checked as createUser checks it: in the agent's guild, and not the agent's own bot.
    const ana = stub.person("ana");
    const away = stub.person("away", { outside: true });
    const people = await discordMaintenance.doctor({
      env: {
        ...env,
        CHANNELSTACK_DISCORD_USER_ANA_TOKEN: ana.token,
        CHANNELSTACK_DISCORD_USER_AWAY_TOKEN: away.token,
        CHANNELSTACK_DISCORD_USER_SELF_TOKEN: stub.bot.token,
      },
      fetch: stub.fetch,
      timers,
      apiBase: stub.apiBase,
    });
    expect(people.map((line) => [line.ok, line.text.split(":")[0]])).toEqual([
      [true, expect.stringContaining("CHANNELSTACK_DISCORD_BOT_TOKEN")],
      [true, expect.stringContaining("CHANNELSTACK_DISCORD_USER_ANA_TOKEN")],
      [false, expect.stringContaining("CHANNELSTACK_DISCORD_USER_AWAY_TOKEN")],
      [false, expect.stringContaining("CHANNELSTACK_DISCORD_USER_SELF_TOKEN")],
    ]);
    expect(people[1]?.text).toContain(`a person's bot ana in guild ${stub.guild}`);
    expect(people[2]?.text).toContain("isn't in the sandbox guild");
    expect(people[3]?.text).toContain("the agent's own bot");
    for (const line of people) for (const token of [ana.token, away.token]) expect(line.text).not.toContain(token);

    await stub.fetch(`${stub.apiBase}/guilds/${stub.guild}/channels`, {
      method: "POST",
      headers: { authorization: `Bot ${stub.bot.token}` },
      body: JSON.stringify({ name: "channelstack-run-crashed1-abcd-1" }),
    });
    const sweep = (check: boolean) =>
      discordMaintenance.sweep({
        env,
        fetch: stub.fetch,
        timers,
        apiBase: stub.apiBase,
        entries: [],
        check,
        run: "crashed1",
        olderThanMs: 0,
        now: Date.now(),
      });
    expect((await sweep(true)).left).toEqual(["channel #channelstack-run-crashed1-abcd-1"]);
    expect((await sweep(false)).removed).toEqual(["channel #channelstack-run-crashed1-abcd-1"]);
    expect((await sweep(true)).left).toEqual([]);
  });
});
