import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

import { LinearWebhookClient } from "@linear/sdk/webhooks";
import notionClient from "@notionhq/client";
import { Webhooks } from "@octokit/webhooks";
import { App, LogLevel } from "@slack/bolt";
import { verifyKey } from "discord-interactions";
import { Client, Events, GatewayIntentBits, type Message, Partials } from "discord.js";
import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { Probot } from "probot";
import { Resend } from "resend";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { freePort } from "../../../scripts/lib/process.ts";
import { waitFor } from "../../../sdks/typescript/runtime/wait.ts";
import { type RunningBinary, startBinary } from "./harness.ts";

const { verifyWebhookSignature } = notionClient;

/**
 * Exit check 12.4: each app is signed for alone. Two apps on every channel, `my-agent` and
 * `coder`, against the fake's real delivery code in the compiled binary, each configured from its
 * own `channelstack env` (`/env`, and `/env?app=coder`), as two agent processes would be. Cases A1
 * to A3 of the appendix in docs/phases.md:
 *
 * - A1, on every channel: an event both apps hear is two deliveries, each to its own app's
 *   endpoint, and each app's official receiver accepts its own and rejects the other's.
 * - A2: Bolt with `ignoreSelf` drops the app's own message and hands another app's to the message
 *   handler; Probot sees another App's comment with `sender.type: "Bot"`.
 * - A3: two apps connected at once, over Socket Mode (Bolt) and the Gateway (discord.js), each get
 *   only their own envelopes and dispatches.
 */

const CHANNELS = ["slack", "github", "linear", "notion", "resend", "google", "discord"] as const;
type Channel = (typeof CHANNELS)[number];
const APPS = ["my-agent", "coder"] as const;
type AppName = (typeof APPS)[number];

/** What one app's endpoint got: the exact bytes and the headers. */
interface Arrival {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
/** What the tests read of an app's `channelstack env`: the variables its agent would start with. */
type Env = Record<
  | "SLACK_API_URL"
  | "SLACK_BOT_TOKEN"
  | "SLACK_APP_TOKEN"
  | "SLACK_SIGNING_SECRET"
  | "GITHUB_APP_ID"
  | "GITHUB_INSTALLATION_ID"
  | "GITHUB_PRIVATE_KEY"
  | "GITHUB_WEBHOOK_SECRET"
  | "LINEAR_WEBHOOK_SECRET"
  | "NOTION_VERIFICATION_TOKEN"
  | "RESEND_WEBHOOK_SECRET"
  | "GOOGLE_API_URL"
  | "GOOGLE_TOKEN_URL"
  | "GOOGLE_CERTS_URL"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "GOOGLE_REFRESH_TOKEN"
  | "GOOGLE_PUBSUB_TOPIC"
  | "GOOGLE_PUSH_SERVICE_ACCOUNT"
  | "DISCORD_API_URL"
  | "DISCORD_TOKEN"
  | "DISCORD_APPLICATION_ID"
  | "DISCORD_PUBLIC_KEY"
  | "DISCORD_GUILD_ID",
  string
>;

let server: RunningBinary;
let listener: Server;
let port: number;
/** What arrived at each app's endpoint, by `<app>/<channel>`. */
const arrived = new Map<string, Arrival[]>();
const endpoint = (app: AppName, channel: Channel) => `http://127.0.0.1:${port}/${app}/${channel}`;
/** Each app's own `channelstack env`. */
const envs = new Map<AppName, Env>();
const envOf = (app: AppName) => envs.get(app) as Env;
/** The Bolt app of each Slack app, over HTTP, that the endpoint hands each delivery to. */
const bolts = new Map<AppName, { app: App; url: string; heard: Array<Record<string, unknown>> }>();

beforeAll(async () => {
  port = await freePort();
  const env: NodeJS.ProcessEnv = {};
  for (const channel of CHANNELS) {
    const upper = channel.toUpperCase();
    env[`CHANNELSTACK_${upper}_WEBHOOK_URL`] = endpoint("my-agent", channel);
    env[`CHANNELSTACK_${upper}_APP_CODER_WEBHOOK_URL`] = endpoint("coder", channel);
  }
  server = await startBinary({ env });
  envs.set("my-agent", (await server.control("GET", "/env")).body);
  // Per channel, as `channelstack env --app coder --channel <channel>` prints it: it makes the app.
  const coder = {} as Env;
  for (const channel of CHANNELS)
    Object.assign(coder, (await server.control("GET", `/env?app=coder&channel=${channel}`)).body);
  envs.set("coder", coder);

  // A Bolt app per Slack app, as a developer would write it, on its own port.
  for (const name of APPS) {
    const boltPort = await freePort();
    const heard: Array<Record<string, unknown>> = [];
    const app = new App({
      token: envOf(name).SLACK_BOT_TOKEN,
      signingSecret: envOf(name).SLACK_SIGNING_SECRET,
      clientOptions: { slackApiUrl: envOf(name).SLACK_API_URL },
      logLevel: LogLevel.ERROR,
    });
    app.message(async ({ message }) => void heard.push(message as unknown as Record<string, unknown>));
    app.event("app_mention", async ({ event }) => void heard.push(event as unknown as Record<string, unknown>));
    await app.start(boltPort);
    bolts.set(name, { app, url: `http://127.0.0.1:${boltPort}/slack/events`, heard });
  }

  // Every app's endpoint: it keeps what came, and answers as the channel's agents do. Slack's is
  // handed to that app's Bolt, whose answer is the endpoint's.
  listener = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const [, app, channel] = (incoming.url ?? "").split("/") as [string, AppName, Channel];
    arrived.set(`${app}/${channel}`, [
      ...(arrived.get(`${app}/${channel}`) ?? []),
      { headers: incoming.headers, body },
    ]);
    if (channel === "slack") {
      const answer = await forward(bolts.get(app)?.url ?? "", { headers: incoming.headers, body });
      return void outgoing.writeHead(answer.status, { "content-type": "application/json" }).end(answer.text);
    }
    if (channel === "discord") {
      const answer = JSON.parse(body).type === 1 ? { type: 1 } : { type: 4, data: { content: `${app} deploys.` } };
      return void outgoing.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    }
    outgoing.writeHead(channel === "google" ? 204 : 200).end();
  });
  await new Promise<void>((resolve) => listener.listen(port, "127.0.0.1", resolve));
}, 60_000);

afterAll(async () => {
  for (const { app } of bolts.values()) await app.stop();
  listener?.closeAllConnections();
  listener?.close();
  await server?.stop();
});

/** Send a delivery, exactly as it came, to a receiver over HTTP: what that receiver answers. */
async function forward(url: string, { headers, body }: Arrival): Promise<{ status: number; text: string }> {
  const sent: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !["host", "content-length", "connection"].includes(name)) sent[name] = String(value);
  }
  const response = await fetch(url, { method: "POST", headers: sent, body });
  return { status: response.status, text: await response.text() };
}

/** A session on a channel, with my-agent's and coder's handles, and the way to act and read. */
async function session(channel: Channel) {
  const { sessionId } = (await server.control("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/${channel}`;
  const act = async (path: string, body?: unknown) => {
    const reply = await server.control("POST", `${base}${path}`, body);
    if (reply.status >= 400) throw new Error(`${path}: ${reply.status} ${JSON.stringify(reply.body)}`);
    return reply.body;
  };
  const read = async (path: string) => (await server.control("GET", `${base}${path}`)).body;
  const { app } = await read("");
  const coder = await act("/apps", { name: "coder" });
  return { base, act, read, app, coder };
}

/** What reached an app's endpoint since `since`, once there is at least `count`. */
async function arrivals(app: AppName, channel: Channel, since: number, count = 1): Promise<Arrival[]> {
  return waitFor(`${count} deliveries to ${app} on ${channel}`, async () => {
    const all = (arrived.get(`${app}/${channel}`) ?? []).slice(since);
    return all.length >= count ? all : undefined;
  });
}
const seen = (app: AppName, channel: Channel) => (arrived.get(`${app}/${channel}`) ?? []).length;

/** The deliveries the fake sent in a session, with the app each went to. */
async function deliveries(base: string) {
  return (await server.control("GET", `${base}/deliveries`)).body as Array<{
    app: string;
    attempts: Array<{ transport?: string; status: string }>;
    status: string;
    type?: string;
  }>;
}

describe("exit check 12.4, A1: each app's official receiver accepts its own delivery and rejects the other's", () => {
  test("A1 slack: Bolt's receiver for each app takes its own event and answers the other's with 401", async () => {
    const { act, app, coder } = await session("slack");
    const ana = await act("/users", { name: "Ana" });
    const channel = await act("/channels", { participants: [ana.id, app.id, coder.id] });
    const [mine, theirs] = [seen("my-agent", "slack"), seen("coder", "slack")];
    await act(`/users/${ana.id}/say`, { message: { text: "the login page answers 500" }, channel: channel.id });

    const [own] = await arrivals("my-agent", "slack", mine);
    const [other] = await arrivals("coder", "slack", theirs);
    if (!own || !other) throw new Error("Both apps were told");
    expect(JSON.parse(own.body).api_app_id).toBe(app.id);
    expect(JSON.parse(other.body).api_app_id).toBe(coder.id);
    expect(JSON.parse(own.body).event_id).not.toBe(JSON.parse(other.body).event_id);
    const boltOf = (name: AppName) => bolts.get(name)?.url ?? "";
    expect((await forward(boltOf("my-agent"), own)).status).toBe(200);
    expect((await forward(boltOf("coder"), other)).status).toBe(200);
    expect((await forward(boltOf("my-agent"), other)).status).toBe(401);
    expect((await forward(boltOf("coder"), own)).status).toBe(401);
  });

  test("A1 github: @octokit/webhooks for each App takes its own delivery, with its installation and target, and refuses the other's", async () => {
    const { act } = await session("github");
    const ana = await act("/users", { login: "ana" });
    const repo = await act("/repos", { collaborators: [{ user: ana.id }], apps: ["my-agent", "coder"] });
    const issue = await act(`/users/${ana.id}/issues`, { issue: { title: "Login fails" }, repo: repo.id });
    const [mine, theirs] = [seen("my-agent", "github"), seen("coder", "github")];
    await act(`/users/${ana.id}/comment`, {
      body: "@coder have a look",
      issue: { repoId: repo.id, number: issue.number },
    });

    const [own] = await arrivals("my-agent", "github", mine);
    const [other] = await arrivals("coder", "github", theirs);
    if (!own || !other) throw new Error("Both Apps were told");
    expect(own.headers["x-github-delivery"]).not.toBe(other.headers["x-github-delivery"]);
    for (const [name, hook] of [
      ["my-agent", own],
      ["coder", other],
    ] as const) {
      expect(hook.headers["x-github-hook-installation-target-id"]).toBe(envOf(name).GITHUB_APP_ID);
      expect(String(JSON.parse(hook.body).installation.id)).toBe(envOf(name).GITHUB_INSTALLATION_ID);
    }
    const receive = (name: AppName, hook: Arrival) =>
      new Webhooks({ secret: envOf(name).GITHUB_WEBHOOK_SECRET }).verifyAndReceive({
        id: String(hook.headers["x-github-delivery"]),
        name: "issue_comment",
        payload: hook.body,
        signature: String(hook.headers["x-hub-signature-256"]),
      });
    await expect(receive("my-agent", own)).resolves.toBeUndefined();
    await expect(receive("coder", other)).resolves.toBeUndefined();
    await expect(receive("my-agent", other)).rejects.toThrow();
    await expect(receive("coder", own)).rejects.toThrow();
  });

  test("A1 linear: LinearWebhookClient for each app takes its own webhook and refuses the other's", async () => {
    const { act } = await session("linear");
    const ana = await act("/users", { name: "Ana" });
    const team = await act("/teams", { key: "ENG", members: [ana.id] });
    const [mine, theirs] = [seen("my-agent", "linear"), seen("coder", "linear")];
    const issue = await act(`/users/${ana.id}/issues`, { issue: { title: "Checkout fails" }, team: team.id });
    await act(`/users/${ana.id}/comment`, { body: "Seen on iOS too", issue: issue.id });

    const own = await arrivals("my-agent", "linear", mine, 2);
    const other = await arrivals("coder", "linear", theirs, 2);
    const verifies = (name: AppName) => (hook: Arrival) => {
      try {
        return new LinearWebhookClient(envOf(name).LINEAR_WEBHOOK_SECRET).verify(
          Buffer.from(hook.body),
          String(hook.headers["linear-signature"]),
        );
      } catch {
        return false;
      }
    };
    expect(own.every(verifies("my-agent"))).toBe(true);
    expect(other.every(verifies("coder"))).toBe(true);
    expect(own.some(verifies("coder"))).toBe(false);
    expect(other.some(verifies("my-agent"))).toBe(false);
  });

  test("A1 notion: verifyWebhookSignature with each integration's token takes its own event and refuses the other's", async () => {
    const { act, app, coder } = await session("notion");
    const ana = await act("/users", { name: "Ana" });
    const page = await act("/pages", { title: "Roadmap", connections: [app.id, coder.id] });
    const [mine, theirs] = [seen("my-agent", "notion"), seen("coder", "notion")];
    await act(`/users/${ana.id}/comment`, { text: "Is this still current?", page: page.id });

    const [own] = await arrivals("my-agent", "notion", mine);
    const [other] = await arrivals("coder", "notion", theirs);
    if (!own || !other) throw new Error("Both integrations were told");
    expect(JSON.parse(own.body).id).not.toBe(JSON.parse(other.body).id);
    const verifies = (name: AppName, hook: Arrival) =>
      verifyWebhookSignature({
        body: hook.body,
        signature: String(hook.headers["x-notion-signature"]),
        verificationToken: envOf(name).NOTION_VERIFICATION_TOKEN,
      });
    expect(await verifies("my-agent", own)).toBe(true);
    expect(await verifies("coder", other)).toBe(true);
    expect(await verifies("my-agent", other)).toBe(false);
    expect(await verifies("coder", own)).toBe(false);
  });

  test("A1 resend: the resend SDK's webhooks.verify with each team's secret takes its own webhook and refuses the other's", async () => {
    const { act, app, coder } = await session("resend");
    const ana = await act("/users", { name: "Ana" });
    const [mine, theirs] = [seen("my-agent", "resend"), seen("coder", "resend")];
    await act(`/users/${encodeURIComponent(ana.id)}/send`, { to: [app.id, coder.id], subject: "Both", text: "Hello" });

    const [own] = await arrivals("my-agent", "resend", mine);
    const [other] = await arrivals("coder", "resend", theirs);
    if (!own || !other) throw new Error("Both teams were told");
    expect(own.headers["svix-id"]).not.toBe(other.headers["svix-id"]);
    const verifier = new Resend("re_123");
    const verifies = (name: AppName, hook: Arrival) => {
      try {
        verifier.webhooks.verify({
          payload: hook.body,
          headers: {
            id: String(hook.headers["svix-id"]),
            timestamp: String(hook.headers["svix-timestamp"]),
            signature: String(hook.headers["svix-signature"]),
          },
          webhookSecret: envOf(name).RESEND_WEBHOOK_SECRET,
        });
        return true;
      } catch {
        return false;
      }
    };
    expect(verifies("my-agent", own)).toBe(true);
    expect(verifies("coder", other)).toBe(true);
    expect(verifies("my-agent", other)).toBe(false);
    expect(verifies("coder", own)).toBe(false);
  });

  test("A1 google: verifyIdToken takes each mailbox's push for its own endpoint and refuses it for the other's", async () => {
    const { act, app, coder } = await session("google");
    const clients = new Map<AppName, OAuth2Client>();
    for (const name of APPS) {
      const env = envOf(name);
      const auth = new OAuth2Client({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        endpoints: { oauth2TokenUrl: env.GOOGLE_TOKEN_URL, oauth2FederatedSignonPemCertsUrl: env.GOOGLE_CERTS_URL },
      });
      auth.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
      // Each agent watches its own inbox, on its own topic.
      const gmail = google.gmail({ version: "v1", auth, rootUrl: env.GOOGLE_API_URL });
      await gmail.users.watch({
        userId: "me",
        requestBody: { topicName: env.GOOGLE_PUBSUB_TOPIC, labelIds: ["INBOX"] },
      });
      clients.set(name, auth);
    }
    const ana = await act("/users", { name: "Ana" });
    const [mine, theirs] = [seen("my-agent", "google"), seen("coder", "google")];
    await act(`/users/${encodeURIComponent(ana.id)}/send`, { to: [app.id, coder.id], subject: "Both", text: "Hello" });

    const [own] = await arrivals("my-agent", "google", mine);
    const [other] = await arrivals("coder", "google", theirs);
    if (!own || !other) throw new Error("Both mailboxes were told");
    expect(JSON.parse(own.body).message.messageId).not.toBe(JSON.parse(other.body).message.messageId);
    const accepts = async (name: AppName, push: Arrival) => {
      const idToken = String(push.headers.authorization).replace(/^Bearer /, "");
      try {
        const ticket = await (clients.get(name) as OAuth2Client).verifyIdToken({
          idToken,
          audience: endpoint(name, "google"),
        });
        return ticket.getPayload()?.email === envOf(name).GOOGLE_PUSH_SERVICE_ACCOUNT;
      } catch {
        return false;
      }
    };
    expect(await accepts("my-agent", own)).toBe(true);
    expect(await accepts("coder", other)).toBe(true);
    expect(await accepts("my-agent", other)).toBe(false);
    expect(await accepts("coder", own)).toBe(false);
  });

  test("A1 discord: an interaction goes to the one app it belongs to, and verifyKey rejects it against the other's key", async () => {
    const { act, app, coder } = await session("discord");
    for (const name of APPS) {
      const env = envOf(name);
      const response = await fetch(
        `${env.DISCORD_API_URL}/v10/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`,
        {
          method: "PUT",
          headers: { authorization: `Bot ${env.DISCORD_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify([{ name: "deploy", description: "Deploy" }]),
        },
      );
      expect(response.status).toBe(200);
    }
    const ana = await act("/users", { name: "Ana" });
    const channel = await act("/channels", { participants: [ana.id, app.id, coder.id] });
    const [mine, theirs] = [seen("my-agent", "discord"), seen("coder", "discord")];
    await act(`/users/${ana.id}/commands`, { command: "/deploy", channel: channel.id, app: coder.id });
    await act(`/users/${ana.id}/commands`, { command: "/deploy", channel: channel.id, app: app.id });

    const [own] = await arrivals("my-agent", "discord", mine);
    const [other] = await arrivals("coder", "discord", theirs);
    if (!own || !other) throw new Error("Each app was sent its own interaction");
    expect(JSON.parse(own.body).application_id).toBe(app.id);
    expect(JSON.parse(other.body).application_id).toBe(coder.id);
    // One interaction each: an interaction goes to the one app it belongs to.
    expect(arrived.get("my-agent/discord")?.slice(mine)).toHaveLength(1);
    expect(arrived.get("coder/discord")?.slice(theirs)).toHaveLength(1);
    const verifies = (name: AppName, hook: Arrival) =>
      verifyKey(
        hook.body,
        String(hook.headers["x-signature-ed25519"]),
        String(hook.headers["x-signature-timestamp"]),
        envOf(name).DISCORD_PUBLIC_KEY,
      );
    expect(await verifies("my-agent", own)).toBe(true);
    expect(await verifies("coder", other)).toBe(true);
    expect(await verifies("my-agent", other)).toBe(false);
    expect(await verifies("coder", own)).toBe(false);
  });
});

describe("exit check 12.4, A2: receivers tell another app's message from their own", () => {
  test("A2 slack: Bolt with ignoreSelf drops the app's own message and hands another app's to the message handler", async () => {
    const { act, app, coder } = await session("slack");
    const ana = await act("/users", { name: "Ana" });
    const channel = await act("/channels", { participants: [ana.id, app.id, coder.id] });
    const [mine, theirs] = [seen("my-agent", "slack"), seen("coder", "slack")];
    const heardBy = (name: AppName) => bolts.get(name)?.heard as Array<Record<string, unknown>>;
    const [mineHeard, theirsHeard] = [heardBy("my-agent").length, heardBy("coder").length];
    await act(`/apps/${coder.id}/say`, { message: { text: "opened #12" }, channel: channel.id });

    // Both apps were sent the message; Bolt hands it on only where another app wrote it.
    const [own] = await arrivals("coder", "slack", theirs);
    await arrivals("my-agent", "slack", mine);
    expect(JSON.parse(own?.body ?? "{}").event).toMatchObject({ bot_id: coder.botId });
    const [message] = await waitFor("Bolt's message handler", async () => {
      const now = heardBy("my-agent").slice(mineHeard);
      return now.length > 0 ? now : undefined;
    });
    expect(message).toMatchObject({
      type: "message",
      text: "opened #12",
      user: coder.botUserId,
      bot_id: coder.botId,
      app_id: coder.id,
      bot_profile: { id: coder.botId, app_id: coder.id, name: "coder" },
    });
    expect(message).not.toHaveProperty("subtype");
    expect(heardBy("coder").slice(theirsHeard)).toEqual([]);
  });

  test("A2 github: Probot receives another App's issue_comment with sender.type Bot", async () => {
    const { act } = await session("github");
    const ana = await act("/users", { login: "ana" });
    const repo = await act("/repos", { collaborators: [{ user: ana.id }], apps: ["my-agent", "coder"] });
    const issue = await act(`/users/${ana.id}/issues`, { issue: { title: "Login fails" }, repo: repo.id });
    const mine = seen("my-agent", "github");
    await act("/apps/coder/comment", { body: "LGTM", issue: { repoId: repo.id, number: issue.number } });

    const [hook] = await arrivals("my-agent", "github", mine);
    if (!hook) throw new Error("my-agent was told");
    const env = envOf("my-agent");
    const probot = new Probot({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      secret: env.GITHUB_WEBHOOK_SECRET,
      logLevel: "fatal",
    });
    const received: Array<{ isBot: boolean; sender: string; type: string }> = [];
    probot.on("issue_comment.created", (context) => {
      received.push({
        isBot: context.isBot,
        sender: context.payload.sender.login,
        type: context.payload.sender.type,
      });
    });
    await probot.ready();
    await probot.webhooks.verifyAndReceive({
      id: String(hook.headers["x-github-delivery"]),
      name: "issue_comment",
      payload: hook.body,
      signature: String(hook.headers["x-hub-signature-256"]),
    });
    expect(received).toEqual([{ isBot: true, sender: "coder[bot]", type: "Bot" }]);
  });
});

describe("exit check 12.4, A3: two apps connected at once each get only their own", () => {
  /** A server where Slack and Discord apps have no endpoint: they are reached over their own connections. */
  let connected: RunningBinary;
  const socket = new Map<AppName, { app: App; heard: Array<Record<string, unknown>> }>();
  const gateway = new Map<AppName, { client: Client; heard: Message[] }>();
  const env = async (name: AppName) =>
    (await connected.control("GET", name === "my-agent" ? "/env" : "/env?app=coder")).body as Env;

  beforeAll(async () => {
    connected = await startBinary({});
    for (const name of APPS) {
      const e = await env(name);
      const heard: Array<Record<string, unknown>> = [];
      const app = new App({
        token: e.SLACK_BOT_TOKEN,
        appToken: e.SLACK_APP_TOKEN,
        socketMode: true,
        clientOptions: { slackApiUrl: e.SLACK_API_URL },
        logLevel: LogLevel.ERROR,
      });
      app.message(async ({ message }) => void heard.push(message as unknown as Record<string, unknown>));
      app.event("app_mention", async ({ event }) => void heard.push(event as unknown as Record<string, unknown>));
      await app.start();
      socket.set(name, { app, heard });

      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel],
        rest: { api: e.DISCORD_API_URL },
      });
      const messages: Message[] = [];
      client.on(Events.MessageCreate, (message) => void messages.push(message));
      await client.login(e.DISCORD_TOKEN);
      gateway.set(name, { client, heard: messages });
    }
  }, 60_000);

  afterAll(async () => {
    for (const { app } of socket.values()) await app.stop();
    for (const { client } of gateway.values()) await client.destroy();
    await connected?.stop();
  });

  /** A session on the connected server. */
  const onConnected = async (channel: "slack" | "discord") => {
    const { sessionId } = (await connected.control("POST", "/sessions")).body;
    const base = `/sessions/${sessionId}/${channel}`;
    const act = async (path: string, body?: unknown) => {
      const reply = await connected.control("POST", `${base}${path}`, body);
      if (reply.status >= 400) throw new Error(`${path}: ${reply.status} ${JSON.stringify(reply.body)}`);
      return reply.body;
    };
    const { app } = (await connected.control("GET", base)).body;
    const coder = await act("/apps", { name: "coder" });
    const ana = await act("/users", { name: "Ana" });
    const settled = () =>
      waitFor("every delivery to settle", async () => {
        const all = (await connected.control("GET", `${base}/deliveries`)).body as Awaited<
          ReturnType<typeof deliveries>
        >;
        return all.length > 0 && all.every((one) => one.status !== "pending") ? all : undefined;
      });
    return { act, app, coder, ana, settled };
  };

  test("A3 slack: two Bolt apps on Socket Mode each get only their own envelopes, each acked on its own connection", async () => {
    const { act, app, coder, ana, settled } = await onConnected("slack");
    const [mineHeard, theirsHeard] = [
      socket.get("my-agent")?.heard.length ?? 0,
      socket.get("coder")?.heard.length ?? 0,
    ];
    // A DM to coder alone, then a mention of coder where both are.
    await act(`/users/${ana.id}/say`, { message: { text: "just for coder" }, to: [coder.id] });
    const channel = await act("/channels", { participants: [ana.id, app.id, coder.id] });
    await act(`/users/${ana.id}/say`, { message: { text: "@coder please look" }, channel: channel.id });

    const all = await settled();
    const texts = (name: AppName) =>
      (socket.get(name)?.heard ?? []).slice(name === "my-agent" ? mineHeard : theirsHeard).map((one) => one.text);
    await waitFor("coder's handlers", async () => (texts("coder").length >= 3 ? true : undefined));
    expect(texts("coder")).toEqual(expect.arrayContaining(["just for coder", `<@${coder.botUserId}> please look`]));
    expect(texts("my-agent")).not.toContain("just for coder");
    expect(texts("my-agent").some((text) => String(text).includes("please look"))).toBe(true);
    // Every envelope went over its own app's connection, and its ack was that app's.
    for (const delivery of all) {
      expect(delivery.attempts.map((attempt) => [attempt.transport, attempt.status])).toEqual([
        ["socket", "acknowledged"],
      ]);
    }
    expect(new Set(all.map((one) => one.app))).toEqual(new Set(["my-agent", "coder"]));
    expect(all.filter((one) => one.app === "my-agent")).toHaveLength(1);
  });

  test("A3 discord: two discord.js bots on the Gateway each get only their own dispatches", async () => {
    const { act, app, coder, ana, settled } = await onConnected("discord");
    const [mineHeard, theirsHeard] = [
      gateway.get("my-agent")?.heard.length ?? 0,
      gateway.get("coder")?.heard.length ?? 0,
    ];
    await act(`/users/${ana.id}/say`, { text: { content: "just for coder" }, to: [coder.id] });
    const channel = await act("/channels", { participants: [ana.id, app.id, coder.id] });
    await act(`/users/${ana.id}/say`, { text: { content: "both of you" }, channel: channel.id });

    await settled();
    const contents = (name: AppName) =>
      (gateway.get(name)?.heard ?? []).slice(name === "my-agent" ? mineHeard : theirsHeard).map((one) => one.content);
    await waitFor("both bots' dispatches", async () =>
      contents("coder").length >= 2 && contents("my-agent").length >= 1 ? true : undefined,
    );
    expect(contents("coder")).toEqual(["just for coder", "both of you"]);
    expect(contents("my-agent")).toEqual(["both of you"]);
  });
});
