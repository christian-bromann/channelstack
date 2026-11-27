import { createServer, type Server } from "node:http";

import { verifyKey } from "discord-interactions";
import { Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { freePort } from "../../../scripts/lib/process.ts";
import { waitFor } from "../../../sdks/typescript/runtime/wait.ts";
import { type RunningBinary, startBinary } from "./harness.ts";

/**
 * Exit check 11.3: the fake's Gateway and interactions, in the compiled binary, against discord.js
 * and Discord's own `verifyKey`. Cases D1 to D8 of the appendix in docs/phases.md.
 */

let gatewayServer: RunningBinary;
let httpServer: RunningBinary;
let client: Client;
let listener: Server;
const seen: Message[] = [];
let resumed = 0;
/** What arrived at the interactions endpoint: the exact bytes and the signature headers. */
const arrived: Array<{ raw: string; signature: string; timestamp: string; valid: boolean }> = [];

type Env = Record<string, string>;
const envOf = async (server: RunningBinary) => (await server.control("GET", "/env")).body as Env;

/** A session on a server with Ana in a channel with the bot. */
async function session(server: RunningBinary) {
  const { sessionId } = (await server.control("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/discord`;
  const act = async (path: string, body?: unknown) => (await server.control("POST", `${base}${path}`, body)).body;
  const read = async (path: string) => (await server.control("GET", `${base}${path}`)).body;
  const { app } = await read("");
  const ana = await act("/users", { name: "Ana" });
  const channel = await act("/channels", { participants: [ana.id, app.id] });
  const say = (content: string) => act(`/users/${ana.id}/say`, { text: { content }, channel: channel.id });
  return { base, act, read, app, ana, channel, say };
}

/** Register `/deploy` the way discord.js does: a bulk overwrite of the guild's commands. */
async function registerDeploy(env: Env) {
  const response = await fetch(
    `${env.DISCORD_API_URL}/v10/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`,
    {
      method: "PUT",
      headers: { authorization: `Bot ${env.DISCORD_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify([
        { name: "deploy", description: "Deploy", options: [{ type: 3, name: "service", description: "What" }] },
      ]),
    },
  );
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  // A bot with no interactions endpoint: everything reaches it over its Gateway connection.
  gatewayServer = await startBinary({});
  const env = await envOf(gatewayServer);
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
    rest: { api: env.DISCORD_API_URL ?? "" },
  });
  client.on(Events.MessageCreate, (message) => {
    if (!message.author.bot) seen.push(message);
  });
  client.on(Events.ShardResume, () => {
    resumed += 1;
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const service = interaction.options.getString("service") ?? "";
    if (service === "slow") await new Promise((resolve) => setTimeout(resolve, 3300));
    await interaction.reply(`Deploying ${service}.`).catch((error: unknown) => {
      interaction.client.emit("debug", `late: ${(error as { code?: number }).code}`);
      lateCodes.push((error as { code?: number }).code ?? 0);
    });
  });
  await registerDeploy(env);
  await client.login(env.DISCORD_TOKEN);

  // A bot with an interactions endpoint: interactions come over HTTP, signed with Ed25519.
  const port = await freePort();
  httpServer = await startBinary({
    env: { CHANNELSTACK_DISCORD_WEBHOOK_URL: `http://127.0.0.1:${port}/interactions` },
  });
  const publicKey = (await envOf(httpServer)).DISCORD_PUBLIC_KEY ?? "";
  // The receiver as Discord's guide has it: verify the bytes as they came, then answer.
  listener = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const signature = String(incoming.headers["x-signature-ed25519"] ?? "");
    const timestamp = String(incoming.headers["x-signature-timestamp"] ?? "");
    const valid = await verifyKey(raw, signature, timestamp, publicKey);
    arrived.push({ raw, signature, timestamp, valid });
    if (!valid) return void outgoing.writeHead(401).end("invalid request signature");
    const body = JSON.parse(raw) as { type: number };
    const answer = body.type === 1 ? { type: 1 } : { type: 4, data: { content: "Deploying over HTTP." } };
    outgoing.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => listener.listen(port, "127.0.0.1", resolve));
  await registerDeploy(await envOf(httpServer));
}, 60_000);

const lateCodes: number[] = [];

afterAll(async () => {
  await client?.destroy();
  listener?.closeAllConnections();
  listener?.close();
  await gatewayServer?.stop();
  await httpServer?.stop();
});

describe("exit check 11.3: the Gateway and interactions work with discord.js and an Ed25519 verify", () => {
  test("D1: discord.js finds the Gateway at /gateway/bot, identifies, and is ready with the guild", async () => {
    const env = await envOf(gatewayServer);
    expect(client.isReady()).toBe(true);
    expect(client.guilds.cache.has(env.DISCORD_GUILD_ID ?? "")).toBe(true);
    expect(client.user?.id).toBe(env.DISCORD_APPLICATION_ID);
    const { read } = await session(gatewayServer);
    expect((await read("")).gatewayConnections).toBe(1);
  });

  test("D2: a person's message reaches discord.js as messageCreate, with its content", async () => {
    const { say, channel } = await session(gatewayServer);
    const sent = await say("is the deploy done?");
    const message = await waitFor("messageCreate", async () => seen.find((each) => each.id === sent.id));
    expect(message.content).toBe("is the deploy done?");
    expect(message.channelId).toBe(channel.id);
    expect(message.author.username).toBe("ana");
  });

  test("D3: a dropped connection is resumed, and what was dispatched meanwhile arrives once", async () => {
    const { act, say } = await session(gatewayServer);
    const before = resumed;
    await act("/faults", { type: "drop_gateway" });
    const sent = await say("are you still there?");
    await waitFor("discord.js to resume", async () => (resumed > before ? true : undefined), { timeout: "20s" });
    await waitFor("messageCreate after the resume", async () => seen.find((each) => each.id === sent.id), {
      timeout: "20s",
    });
    // A replay comes before anything dispatched after the RESUME: once the next message is there, a
    // second copy of the first would be too.
    const next = await say("and now?");
    await waitFor("the next messageCreate", async () => seen.find((each) => each.id === next.id));
    expect(seen.filter((each) => each.id === sent.id)).toHaveLength(1);
  });

  test("D4: a bad token is closed with 4004; a privileged intent the app doesn't have with 4014", async () => {
    const { url } = (await (await fetch(`${(await envOf(gatewayServer)).DISCORD_API_URL}/v10/gateway`)).json()) as {
      url: string;
    };
    const closeCode = (identify: unknown) =>
      new Promise<number>((resolve) => {
        const socket = new WebSocket(`${url}?v=10&encoding=json`);
        socket.onmessage = (event) => {
          if ((JSON.parse(String(event.data)) as { op: number }).op === 10)
            socket.send(JSON.stringify({ op: 2, d: identify }));
        };
        socket.onclose = (event) => resolve(event.code);
      });
    expect(await closeCode({ token: "not-the-token", intents: 1, properties: {} })).toBe(4004);
    const token = (await envOf(gatewayServer)).DISCORD_TOKEN;
    expect(await closeCode({ token, intents: GatewayIntentBits.GuildPresences, properties: {} })).toBe(4014);
  });

  test("D5: verifyKey accepts an interaction signed with the install's key over the sent bytes", async () => {
    const { act, ana, channel } = await session(httpServer);
    const delivery = await act(`/users/${ana.id}/commands`, { command: "/deploy web", channel: channel.id });
    const sent = await waitFor("the interaction", async () => arrived.find((each) => each.raw.includes(delivery.id)));
    expect(sent.valid).toBe(true);
    expect(JSON.parse(sent.raw)).toMatchObject({ type: 2, data: { name: "deploy", options: [{ value: "web" }] } });
  });

  test("D6: a re-serialized body, or another key, is rejected", async () => {
    const { act, ana, channel } = await session(httpServer);
    const publicKey = (await envOf(httpServer)).DISCORD_PUBLIC_KEY ?? "";
    const delivery = await act(`/users/${ana.id}/commands`, { command: "/deploy api", channel: channel.id });
    const sent = await waitFor("the interaction", async () => arrived.find((each) => each.raw.includes(delivery.id)));
    const reserialized = JSON.stringify(JSON.parse(sent.raw), null, 1);
    expect(await verifyKey(reserialized, sent.signature, sent.timestamp, publicKey)).toBe(false);
    const forged = await act(`/deliveries/${delivery.id}/resend`, { badSignature: true });
    expect(forged).toMatchObject({ forgedSignature: true, responseStatus: 401 });
  });

  test("D7: over the Gateway, a slash command is interactionCreate; its reply in time is the response, one after 3 s is 10062", async () => {
    const { act, ana, channel, read } = await session(gatewayServer);
    await act(`/users/${ana.id}/commands`, { command: "/deploy web", channel: channel.id });
    await waitFor("the reply", async () =>
      /Deploying web\./.test((await read(`/channels/${channel.id}/transcript`)).text) ? true : undefined,
    );
    await act(`/users/${ana.id}/commands`, { command: "/deploy slow", channel: channel.id });
    await waitFor("the late reply to be refused", async () => (lateCodes.includes(10062) ? true : undefined), {
      timeout: "10s",
    });
    const asAna = (await read(`/channels/${channel.id}/transcript?as=${ana.id}`)).text as string;
    expect(asAna).toContain("This interaction failed (only Ana sees this)");
  });

  test("D8: Discord's endpoint check: a PING is answered with a PONG, and a forged PING refused with 401", async () => {
    const { act } = await session(httpServer);
    expect(await act("/verify-endpoint")).toMatchObject({ valid: true, problems: [] });
  });
});
