/**
 * Exit checks 12.3 and 12.4 for Discord: several apps in one guild (decision 0027). Each is an
 * application with its own bot user, token and Ed25519 key, and its own Gateway connection and
 * interactions endpoint. A bot hears what the other bots do as Discord sends it: their messages,
 * edits, deletes and reactions with `author.bot` and their id, the content only with
 * `MESSAGE_CONTENT` or a mention. What Discord refuses between bots, the fake refuses: a DM to
 * another bot (50007). Interactions are people's, and go to the one app they belong to.
 */
import { verifyKey } from "discord-interactions";
import { afterEach, describe, expect, test } from "vitest";

import { type RecordingAgent, recordingAgent, refusal, watchCredentials } from "../../../test/app-harness.ts";
import { discordWorkspace } from "../../../test/discord-workspace.ts";
import { discordDispatchProblems } from "../../../test/schemas/discord.ts";
import { LOOP_LIMIT } from "../../core/loops/index.ts";
import { botIdOf } from "./secrets.ts";

const agents: RecordingAgent[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const agent of agents.splice(0)) agent.close();
  for (const close of closers.splice(0)) close();
});

/** Every intent the reference agent asks for, MESSAGE_CONTENT among them. */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 10) | (1 << 12) | (1 << 13) | (1 << 15);

/** A guild with my-agent and `coder`, each on its Gateway connection: Ana in a channel with my-agent, and in one with both. */
async function twoApps() {
  const space = await discordWorkspace();
  const { control, fixture, ana } = space;
  const post = async (path: string, body?: unknown) => {
    const response = await control("POST", path, body);
    if (response.status >= 400) throw Object.assign(new Error(response.body.error), response);
    return response.body;
  };
  const app = fixture.app;
  const coder = await post("/apps", { name: "coder" });
  const both = await post("/channels", { participants: [ana.id, app.id, coder.id] });
  /** A REST call as coder's bot. */
  const asCoder = (method: string, path: string, body?: unknown) =>
    space.api(method, path, body, `Bot ${coder.botToken}`);
  return { ...space, post, app, coder, both, asCoder };
}

const created = (gateway: { dispatches(): Array<{ t: string; d: any }> }, type = "MESSAGE_CREATE") =>
  gateway.dispatches().filter((payload) => payload.t === type);

describe("exit check 12.3: Discord apps", () => {
  test("an app has its own application, bot, token and key, and the same name gives the same app", async () => {
    const { h, post, control, app, coder } = await twoApps();
    expect(coder).toMatchObject({ name: "coder", kind: "app", channel: "discord", guildId: app.guildId });
    expect(coder.id).toMatch(/^[1-9]\d{16,19}$/);
    // A bot's id is in its token, as Discord's are; the application and its bot have the same id.
    expect(botIdOf(coder.botToken)).toBe(coder.id);
    expect(coder.botUserId).toBe(coder.id);
    expect(coder.botToken).toBe(h.secrets.forApp("discord", "coder", "botToken"));
    for (const key of ["id", "botToken", "publicKey"]) expect(coder[key]).not.toBe(app[key]);
    expect(await post("/apps", { name: "coder" })).toEqual(coder);
    expect((await control("GET", "/apps")).body.map((one: { name: string }) => one.name)).toEqual([
      "my-agent",
      "coder",
    ]);
    expect(await refusal(post("/apps", { name: "coder", privilegedIntents: ["MESSAGE_CONTENT"] }))).toBe(
      "invalid_argument",
    );
    expect(await refusal(post("/apps", { name: "my-agent" }))).toBe("invalid_argument");
  });

  test("each token answers as its own bot: who it is, its application, what it may see and change", async () => {
    const { api, asCoder, app, coder, channel, both } = await twoApps();
    expect((await asCoder("GET", "/users/@me")).body).toMatchObject({
      id: coder.botUserId,
      username: "coder",
      bot: true,
    });
    expect((await asCoder("GET", "/applications/@me")).body).toMatchObject({
      id: coder.id,
      verify_key: coder.publicKey,
    });
    expect((await api("GET", "/users/@me")).body.id).toBe(app.botUserId);
    // Ana's first channel has my-agent only: coder's bot doesn't see it.
    expect((await asCoder("POST", `/channels/${channel.id}/messages`, { content: "hi" })).body.code).toBe(50001);
    const written = await asCoder("POST", `/channels/${both.id}/messages`, { content: "opened #12" });
    expect(written.body.author).toMatchObject({ id: coder.botUserId, bot: true });
    // A bot changes its own messages only.
    expect(
      (await api("PATCH", `/channels/${both.id}/messages/${written.body.id}`, { content: "mine now" })).body.code,
    ).toBe(50005);
    // Each bot manages its own commands only.
    expect((await asCoder("GET", `/applications/${app.id}/commands`)).body.code).toBe(50001);
  });

  test("A3: each bot's Gateway connection gets only its own dispatches, and can't resume the other's session", async () => {
    const { identify, connect, say, control, app, coder, channel, both } = await twoApps();
    const mine = await identify();
    const theirs = await identify(INTENTS, coder.botToken);
    closers.push(
      () => mine.disconnect(),
      () => theirs.disconnect(),
    );
    expect(created(mine, "READY")[0]?.d.user.id).toBe(app.botUserId);
    expect(created(theirs, "READY")[0]?.d).toMatchObject({
      user: { id: coder.botUserId },
      application: { id: coder.id },
    });

    await say("only my-agent sees this", { channel: channel.id });
    await say("both see this", { channel: both.id });

    expect(created(mine).map((payload) => payload.d.content)).toEqual(["only my-agent sees this", "both see this"]);
    expect(created(theirs).map((payload) => payload.d.content)).toEqual(["both see this"]);
    // The fixture counts the built-in app's connections.
    expect((await control("GET", "")).body.gatewayConnections).toBe(1);

    // A session is its bot's: coder's token can't resume my-agent's.
    const ready = created(mine, "READY")[0]?.d;
    const thief = await connect();
    thief.send({ op: 6, d: { token: coder.botToken, session_id: ready.session_id, seq: 0 } });
    expect(thief.received.at(-1)).toEqual({ op: 9, d: false });
  });

  test("another bot's message reaches every bot in the channel with author.bot and its id; its edits, deletes and reactions too", async () => {
    const { h, identify, asCoder, coder, both } = await twoApps();
    const mine = await identify();
    const theirs = await identify(INTENTS, coder.botToken);
    closers.push(
      () => mine.disconnect(),
      () => theirs.disconnect(),
    );

    const written = (await asCoder("POST", `/channels/${both.id}/messages`, { content: "opened #12" })).body;
    await asCoder("PATCH", `/channels/${both.id}/messages/${written.id}`, { content: "opened #12, ready" });
    await asCoder("PUT", `/channels/${both.id}/messages/${written.id}/reactions/${encodeURIComponent("👀")}/@me`);
    await asCoder("DELETE", `/channels/${both.id}/messages/${written.id}`);
    await h.app.settled();

    const heard = mine.dispatches().filter((payload) => payload.t.startsWith("MESSAGE_"));
    expect(heard.map((payload) => payload.t)).toEqual([
      "MESSAGE_CREATE",
      "MESSAGE_UPDATE",
      "MESSAGE_REACTION_ADD",
      "MESSAGE_DELETE",
    ]);
    expect(heard[0]?.d).toMatchObject({
      content: "opened #12",
      author: { id: coder.botUserId, username: "coder", bot: true },
      member: { roles: [expect.any(String)] },
    });
    expect(heard[1]?.d).toMatchObject({ content: "opened #12, ready", author: { id: coder.botUserId, bot: true } });
    expect(heard[2]?.d).toMatchObject({ user_id: coder.botUserId, message_author_id: coder.botUserId });
    expect(heard[3]?.d).toMatchObject({ id: written.id, channel_id: both.id });
    // Discord sends a bot its own messages too; discord.js's handlers check the author.
    expect(created(theirs)[0]?.d.author.id).toBe(coder.botUserId);
  });

  test("another bot's reaction removed reaches every bot in the channel as MESSAGE_REACTION_REMOVE", async () => {
    const { h, identify, asCoder, coder, both } = await twoApps();
    const mine = await identify();
    closers.push(() => mine.disconnect());

    const written = (await asCoder("POST", `/channels/${both.id}/messages`, { content: "opened #12" })).body;
    const reaction = `/channels/${both.id}/messages/${written.id}/reactions/${encodeURIComponent("👀")}/@me`;
    await asCoder("PUT", reaction);
    await asCoder("DELETE", reaction);
    await h.app.settled();

    const heard = mine.dispatches().filter((payload) => payload.t.startsWith("MESSAGE_REACTION_"));
    expect(heard.map((payload) => payload.t)).toEqual(["MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE"]);
    expect(heard[1]?.d).toMatchObject({
      user_id: coder.botUserId,
      message_id: written.id,
      channel_id: both.id,
      emoji: { name: "👀" },
    });
    for (const payload of heard) expect(discordDispatchProblems(payload.t, payload.d)).toEqual([]);
  });

  test("without MESSAGE_CONTENT, another bot's message is empty unless it mentions the bot", async () => {
    const { h, identify, asCoder, app, coder, both } = await twoApps();
    const mine = await identify((1 << 0) | (1 << 9));
    closers.push(() => mine.disconnect());
    await asCoder("POST", `/channels/${both.id}/messages`, { content: "plain words" });
    await asCoder("POST", `/channels/${both.id}/messages`, { content: `<@${app.botUserId}> please review` });
    await h.app.settled();
    expect(created(mine).map((payload) => payload.d.content)).toEqual(["", `<@${app.botUserId}> please review`]);
    expect(created(mine).map((payload) => payload.d.author.id)).toEqual([coder.botUserId, coder.botUserId]);
  });

  test("no bot writes to another bot in a DM: 50007, from its own call and from a scripted app", async () => {
    const { asCoder, post, app, coder } = await twoApps();
    expect((await asCoder("POST", "/users/@me/channels", { recipient_id: app.botUserId })).body.code).toBe(50007);
    const bot = await post("/users", { name: "Deploy Bot", bot: true });
    expect(await refusal(post(`/apps/${coder.id}/say`, { text: { content: "hi" }, to: [app.id] }))).toBe(
      "cannot_message_user",
    );
    expect(await refusal(post(`/apps/${coder.id}/say`, { text: { content: "hi" }, to: [bot.id] }))).toBe(
      "cannot_message_user",
    );
  });

  test("a scripted app says, replies and reacts as its own calls would, where its bot sees; never as my-agent", async () => {
    const { h, identify, post, control, app, coder, channel, both } = await twoApps();
    const mine = await identify();
    closers.push(() => mine.disconnect());

    const said = await post(`/apps/${coder.id}/say`, {
      text: { content: "@my-agent the deploy finished" },
      channel: both.id,
    });
    const replied = await post(`/apps/${coder.id}/reply`, { text: { content: "details" }, message: said });
    await post(`/apps/${coder.id}/react`, { emoji: "🚀", message: said });
    await h.app.settled();

    expect(said.author).toMatchObject({ kind: "app", name: "coder", id: coder.id });
    expect(said.content).toBe(`<@${app.botUserId}> the deploy finished`);
    expect(replied.replyTo).toBe(said.id);
    expect(said.delivery).toMatchObject({ app: "my-agent", type: "MESSAGE_CREATE" });
    expect(
      mine
        .dispatches()
        .filter((payload) => payload.t.startsWith("MESSAGE_"))
        .map((payload) => payload.t),
    ).toEqual(["MESSAGE_CREATE", "MESSAGE_CREATE", "MESSAGE_REACTION_ADD"]);
    const transcript = (await control("GET", `/channels/${both.id}/transcript`)).body.text;
    expect(transcript).toContain("coder: @my-agent the deploy finished");
    expect(await refusal(post(`/apps/${coder.id}/say`, { text: { content: "hi" }, channel: channel.id }))).toBe(
      "missing_access",
    );
    expect(await refusal(post(`/apps/${app.id}/say`, { text: { content: "hi" }, channel: both.id }))).toBe(
      "invalid_argument",
    );
    expect(await refusal(post("/apps/nobody/say", { text: { content: "hi" }, channel: both.id }))).toBe("not_found");
  });

  test("every delivery says which app it went to; a message's is my-agent's, another's is asked for by app", async () => {
    const { h, identify, post, control, coder, ana, both } = await twoApps();
    const mine = await identify();
    const theirs = await identify(INTENTS, coder.botToken);
    closers.push(
      () => mine.disconnect(),
      () => theirs.disconnect(),
    );
    const msg = await post(`/users/${ana.id}/say`, { text: { content: "@coder fix it" }, channel: both.id });
    await h.app.settled();
    expect(msg.delivery).toMatchObject({ app: "my-agent", type: "MESSAGE_CREATE" });
    const forCoder = (await control("GET", `/channels/${both.id}/messages/${msg.id}/delivery-for?app=${coder.id}`))
      .body;
    expect(forCoder).toMatchObject({
      app: "coder",
      type: "MESSAGE_CREATE",
      payload: { content: expect.stringMatching(/fix it$/) },
    });
    const all = (await control("GET", `/channels/${both.id}/messages/${msg.id}/deliveries`)).body as { app: string }[];
    expect(all.map((one) => one.app)).toEqual(["my-agent", "coder"]);
  });

  test("exit check 12.6: two apps answering each other are stopped at the guard's limit, and the session says so", async () => {
    const { h, identify, post, sessionId, app, coder, ana } = await twoApps();
    const mine = await identify();
    closers.push(() => mine.disconnect());
    const reviewer = await post("/apps", { name: "reviewer" });
    const channel = await post("/channels", { participants: [ana.id, app.id, coder.id, reviewer.id] });
    await post(`/users/${ana.id}/say`, { text: { content: "go" }, channel: channel.id });
    for (let i = 0; i < LOOP_LIMIT + 5; i++) {
      await post(`/apps/${i % 2 === 0 ? coder.id : reviewer.id}/say`, {
        text: { content: `turn ${i}` },
        channel: channel.id,
      });
    }
    await h.app.settled();
    const inLoop = () => created(mine).filter((payload) => payload.d.channel_id === channel.id).length;

    // my-agent heard Ana, then each app message up to the limit, and nothing after.
    expect(inLoop()).toBe(1 + LOOP_LIMIT);
    const quiet = (await h.call("GET", `/sessions/${sessionId}/quiet`)).body;
    expect(quiet.loops).toEqual([
      expect.stringMatching(/^a bot loop in discord \d+ was stopped after 50 app messages/),
    ]);
    // A person writing again starts the channel over.
    await post(`/users/${ana.id}/say`, { text: { content: "again" }, channel: channel.id });
    await post(`/apps/${coder.id}/say`, { text: { content: "back" }, channel: channel.id });
    await h.app.settled();
    expect(inLoop()).toBe(3 + LOOP_LIMIT);
  });

  test("an app's bot token comes with its handle only: no author, member or reactor holds it", async () => {
    const { h, control, app, coder, both, asCoder } = await twoApps();
    const watch = watchCredentials(h, "discord");
    const written = (await asCoder("POST", `/channels/${both.id}/messages`, { content: "opened #12" })).body;
    await asCoder("PUT", `/channels/${both.id}/messages/${written.id}/reactions/${encodeURIComponent("👀")}/@me`);
    await h.app.settled();
    const at = `/channels/${both.id}`;
    const reads = [
      ...["/messages", "/members", "/transcript"].map((read) => `${at}${read}`),
      ...["", "/reactions", "/transcript"].map((read) => `${at}/messages/${written.id}${read}`),
    ];
    for (const read of reads) expect([read, (await control("GET", read)).status]).toEqual([read, 200]);
    expect((await control("GET", "/apps")).body.map((one: { botToken: string }) => one.botToken)).toEqual([
      app.botToken,
      coder.botToken,
    ]);

    expect([app.botToken, coder.botToken].every((token) => token.length > 0)).toBe(true);
    expect(watch.leaks([app.botToken, coder.botToken])).toEqual([]);
  });

  test("a person and an app of one session can't share a name", async () => {
    const { post } = await twoApps();
    expect(await refusal(post("/users", { name: "coder" }))).toBe("invalid_argument");
    await post("/users", { name: "reviewer" });
    expect(await refusal(post("/apps", { name: "reviewer" }))).toBe("invalid_argument");
  });

  test("exit check 12.5: channelstack env --app prints the app's lines under my-agent's keys", async () => {
    const { h, coder, app } = await twoApps();
    const env = (await h.call("GET", "/env?app=coder&channel=discord")).body;
    expect(env).toMatchObject({
      DISCORD_TOKEN: coder.botToken,
      DISCORD_APPLICATION_ID: coder.id,
      DISCORD_PUBLIC_KEY: coder.publicKey,
      DISCORD_GUILD_ID: app.guildId,
    });
    expect((await h.call("GET", "/env?app=my-agent&channel=discord")).body.DISCORD_TOKEN).toBe(app.botToken);
    // An app no test made yet is made by asking for its lines, so its agent can start first.
    expect((await h.call("GET", "/env?app=reviewer&channel=discord")).body.DISCORD_TOKEN).toBe(
      h.secrets.forApp("discord", "reviewer", "botToken"),
    );
  });
});

/**
 * Two apps that each take interactions at an endpoint of their own, my-agent's and coder's, with
 * both bots on the Gateway for what isn't an interaction.
 */
async function interactionApps() {
  const theirs = await recordingAgent();
  agents.push(theirs);
  const space = await discordWorkspace({
    interactions: true,
    appWebhooks: (_driver, app) => (app === "coder" ? theirs.url : undefined),
  });
  const mine = space.agent;
  if (!mine) throw new Error("no agent");
  agents.push(mine);
  const control = async (method: string, path: string, body?: unknown) => {
    const response = await space.control(method, path, body);
    if (response.status >= 400) throw Object.assign(new Error(response.body.error), response);
    return response.body;
  };
  const app = space.fixture.app;
  const coder = await control("POST", "/apps", { name: "coder" });
  const own = await space.identify();
  const other = await space.identify(INTENTS, coder.botToken);
  closers.push(
    () => own.disconnect(),
    () => other.disconnect(),
  );
  const both = await control("POST", "/channels", { participants: [space.ana.id, app.id, coder.id] });
  const api = (method: string, path: string, body: unknown, token: string) =>
    space.api(method, path, body, `Bot ${token}`);
  /** Register `/deploy` for an app, as discord.js does: a bulk overwrite of its guild commands. */
  const register = (who: { id: string; botToken: string }) =>
    api(
      "PUT",
      `/applications/${who.id}/guilds/${space.fixture.guild.id}/commands`,
      [{ name: "deploy", description: "Deploy", options: [{ type: 3, name: "service", description: "What" }] }],
      who.botToken,
    );
  return { h: space.h, control, app, coder, ana: space.ana, both, api, register, mine, theirs };
}

describe("exit check 12.4: each app's interactions are its own", () => {
  test("A1: a command goes to the one app it belongs to, signed with that app's key, which verifyKey rejects against the other's", async () => {
    const { h, control, app, coder, ana, both, register, mine, theirs } = await interactionApps();
    await register(app);
    await register(coder);
    theirs.respond = () => ({ status: 200, body: JSON.stringify({ type: 4, data: { content: "Deploying web." } }) });
    mine.respond = () => ({ status: 200, body: JSON.stringify({ type: 4, data: { content: "Mine deploys." } }) });

    const delivery = await control("POST", `/users/${ana.id}/commands`, {
      command: "/deploy web",
      channel: both.id,
      app: coder.id,
    });
    await h.app.settled();

    expect(mine.received).toEqual([]);
    const [received] = theirs.received;
    const body = JSON.parse(received?.body ?? "{}");
    expect(body).toMatchObject({ type: 2, application_id: coder.id, data: { name: "deploy" } });
    expect(delivery).toMatchObject({ app: "coder", type: "INTERACTION_CREATE" });
    const signature = String(received?.headers["x-signature-ed25519"]);
    const timestamp = String(received?.headers["x-signature-timestamp"]);
    expect(await verifyKey(received?.body ?? "", signature, timestamp, coder.publicKey)).toBe(true);
    expect(await verifyKey(received?.body ?? "", signature, timestamp, app.publicKey)).toBe(false);
    expect((await control("GET", `/channels/${both.id}/transcript`)).text).toBe("coder: Deploying web.");

    // Without an app, the person picks the built-in app's command of that name.
    await control("POST", `/users/${ana.id}/commands`, { command: "/deploy api", channel: both.id });
    await h.app.settled();
    const [own] = mine.received;
    expect(mine.received).toHaveLength(1);
    expect(
      await verifyKey(
        own?.body ?? "",
        String(own?.headers["x-signature-ed25519"]),
        String(own?.headers["x-signature-timestamp"]),
        app.publicKey,
      ),
    ).toBe(true);
  });

  test("a button on another app's message is that app's: the press goes to it alone, and it answers as itself", async () => {
    const { h, control, app, coder, ana, both, api, mine, theirs } = await interactionApps();
    const components = [{ type: 1, components: [{ type: 2, style: 1, label: "Merge", custom_id: "merge:12" }] }];
    const ask = (
      await api("POST", `/channels/${both.id}/messages`, { content: "Merge #12?", components }, coder.botToken)
    ).body as { id: string };
    theirs.respond = () => ({
      status: 200,
      body: JSON.stringify({ type: 7, data: { content: "Merged.", components: [] } }),
    });

    await control("POST", `/users/${ana.id}/click`, {
      button: { label: "Merge" },
      message: { channelId: both.id, id: ask.id },
    });
    await h.app.settled();

    expect(mine.received).toEqual([]);
    expect(JSON.parse(theirs.received[0]?.body ?? "{}")).toMatchObject({
      type: 3,
      application_id: coder.id,
      data: { custom_id: "merge:12" },
      message: { id: ask.id, author: { id: coder.botUserId } },
    });
    expect((await control("GET", `/channels/${both.id}/transcript`)).text).toBe("coder: Merged. (edited)");
    // An interaction's token is its app's: my-agent's application id finds nothing with it.
    const token = JSON.parse(theirs.received[0]?.body ?? "{}").token;
    expect(
      (await api("GET", `/webhooks/${app.id}/${token}/messages/@original`, undefined, app.botToken)).body.code,
    ).toBe(10015);
  });
});

describe("R1.12: faults by app", () => {
  test("drop_gateway that names an app drops that app's bot's connection alone", async () => {
    const space = await discordWorkspace();
    const { control, identify, fixture, ana, say } = space;
    const coder = (await control("POST", "/apps", { name: "coder" })).body;
    const both = (await control("POST", "/channels", { participants: [ana.id, fixture.app.id, coder.id] })).body;
    const intents = (1 << 0) | (1 << 9) | (1 << 15);
    const mine = await identify(intents);
    const theirs = await identify(intents, coder.botToken);

    await control("POST", "/faults", { type: "drop_gateway", app: coder.id });
    await say("hello both", { channel: both.id });
    await space.h.app.settled();

    expect(theirs.closed).toEqual({ code: null });
    expect(mine.closed).toBeUndefined();
    expect(mine.dispatches().some((payload) => payload.d?.content === "hello both")).toBe(true);
  });

  test("a rate_limit that names an app refuses that app's calls alone", async () => {
    const space = await discordWorkspace();
    const { control, api, h, ana, fixture } = space;
    const coder = (await control("POST", "/apps", { name: "coder" })).body;
    const both = (await control("POST", "/channels", { participants: [ana.id, fixture.app.id, coder.id] })).body;
    await control("POST", "/faults", { type: "rate_limit", app: coder.id });
    const asCoder = await h.provider("POST", `discord/api/v10/channels/${both.id}/messages`, { content: "hi" }, null, {
      authorization: `Bot ${coder.botToken}`,
    });
    expect(asCoder.status).toBe(429);
    expect((await api("POST", `/channels/${both.id}/messages`, { content: "hi" })).status).toBe(200);
  });

  test("exit check 12.6: once stopped, a channel's bot edits, reactions and threads cause nothing, a scripted bot doesn't start it over, and a thread is its own conversation", async () => {
    const { h, identify, post, asCoder, sessionId, app, coder, ana } = await twoApps();
    const mine = await identify();
    closers.push(() => mine.disconnect());
    const robot = await post("/users", { name: "Robot", bot: true });
    const channel = await post("/channels", { participants: [ana.id, app.id, coder.id, robot.id] });
    await post(`/users/${ana.id}/say`, { text: { content: "go" }, channel: channel.id });
    // A scripted bot user and coder answer each other: the bot counts as a bot, by its name.
    let last: { id: string } | undefined;
    for (let i = 0; i <= LOOP_LIMIT; i++) {
      if (i % 2 === 0)
        last = await post(`/apps/${coder.id}/say`, { text: { content: `turn ${i}` }, channel: channel.id });
      else await post(`/users/${robot.id}/say`, { text: { content: `turn ${i}` }, channel: channel.id });
    }
    await h.app.settled();
    const quiet = (await h.call("GET", `/sessions/${sessionId}/quiet`)).body;
    expect(quiet.loops).toEqual([expect.stringMatching(/stopped after 50 app messages .*coder → Robot → coder/)]);
    if (!last) throw new Error("coder said nothing");
    const seen = mine.dispatches().length;

    // coder's edit, reaction and thread in the stopped channel are kept, and dispatch nothing.
    expect((await asCoder("PATCH", `/channels/${channel.id}/messages/${last.id}`, { content: "edited" })).status).toBe(
      200,
    );
    expect(
      (await asCoder("PUT", `/channels/${channel.id}/messages/${last.id}/reactions/%F0%9F%91%8D/@me`)).status,
    ).toBe(204);
    const thread = await asCoder("POST", `/channels/${channel.id}/messages/${last.id}/threads`, { name: "More" });
    expect(thread.status).toBe(201);
    await h.app.settled();
    expect(mine.dispatches().length).toBe(seen);

    // The thread is a conversation of its own: coder's message there is dispatched.
    expect((await asCoder("POST", `/channels/${thread.body.id}/messages`, { content: "in the thread" })).status).toBe(
      200,
    );
    await h.app.settled();
    expect(created(mine).at(-1)?.d).toMatchObject({ channel_id: thread.body.id, content: "in the thread" });
  });
});
