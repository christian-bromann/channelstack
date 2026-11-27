import { expect } from "vitest";

import { harness, type RecordingAgent, recordingAgent } from "./app-harness.ts";
import { discordDispatchProblems, discordResponseProblems } from "./schemas/discord.ts";

/** One Gateway connection as a test drives it: what the fake sent, and a way to send it payloads. */
export interface TestGateway {
  /** Every payload the fake sent, parsed. */
  readonly received: Array<{ op: number; t?: string; s?: number; d?: any }>;
  /** The close code and reason, once the fake closed the connection; `null` code for a drop. */
  readonly closed: { code: number | null; reason?: string } | undefined;
  send(payload: unknown): void;
  /** The dispatches so far, each held to Discord's description where it has the object. */
  dispatches(): Array<{ t: string; s: number; d: any }>;
  /** The connection goes away from the bot's side (a network drop). */
  disconnect(): void;
}

/**
 * A guild for a unit test: the app, a session with Ana in a channel with the bot, and the bot's
 * REST calls and Gateway as discord.js makes them. Every answer is held to Discord's description.
 * With `interactions`, the app has an interactions endpoint: a stand-in agent that records them.
 */
export async function discordWorkspace(options: { interactions?: boolean } = {}) {
  const agent: RecordingAgent | undefined = options.interactions ? await recordingAgent() : undefined;
  const h = harness({ discord: agent?.url });
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const control = (method: string, path: string, body?: unknown) =>
    h.call(method, `/sessions/${sessionId}/discord${path}`, body);
  const fixture = (await control("GET", "")).body;
  const token = h.secrets.get("discord", "botToken");
  const ana = (await control("POST", "/users", { name: "Ana" })).body;
  const channel = (await control("POST", "/channels", { participants: [ana.id, fixture.app.id] })).body;

  /** A REST call as the bot, with its token; a 2xx answer is held to Discord's description. */
  const api = async (method: string, path: string, body?: unknown, auth: string | null = `Bot ${token}`) => {
    const reply = await h.provider(method, `discord/api/v10${path}`, body, null, auth ? { authorization: auth } : {});
    // Refusals too: Discord's description has the shape of its errors and its 429.
    if (reply.status !== 204) expect(discordResponseProblems(method, path, reply.status, reply.body)).toEqual([]);
    return reply as { status: number; body: any };
  };

  /** Open a Gateway connection the way discord.js does, at the URL `GET /gateway/bot` gives. */
  const connect = async (query = "?v=10&encoding=json"): Promise<TestGateway> => {
    const { url } = (await api("GET", "/gateway/bot")).body;
    const socket = h.app.socket(new Request(`${String(url).replace(/^ws/, "http")}${query}`));
    if (!socket) throw new Error("The fake refused the Gateway connection");
    const gateway = {
      received: [] as TestGateway["received"],
      closed: undefined as TestGateway["closed"],
      send: (payload: unknown) => socket.message(typeof payload === "string" ? payload : JSON.stringify(payload)),
      dispatches() {
        const dispatched = gateway.received.filter((payload) => payload.op === 0) as Array<{
          t: string;
          s: number;
          d: any;
        }>;
        for (const { t, d } of dispatched) expect(discordDispatchProblems(t, d)).toEqual([]);
        return dispatched;
      },
      disconnect: () => socket.closed(),
    };
    socket.open({
      send: (text) => gateway.received.push(JSON.parse(text)),
      close: (code, reason) => {
        gateway.closed = { code: code ?? null, ...(reason === undefined ? {} : { reason }) };
        socket.closed();
      },
    });
    return gateway;
  };

  /** Connect and identify with these intents (every one the reference agent asks for by default). */
  const identify = async (intents = (1 << 0) | (1 << 9) | (1 << 10) | (1 << 12) | (1 << 13) | (1 << 15)) => {
    const gateway = await connect();
    gateway.send({ op: 2, d: { token, intents, properties: { os: "linux", browser: "test", device: "test" } } });
    return gateway;
  };

  const say = async (text: string, where: Record<string, unknown> = { channel: channel.id }, who = ana.id) =>
    (await control("POST", `/users/${who}/say`, { text: { content: text }, ...where })).body;

  return { h, agent, sessionId, control, fixture, token, ana, channel, api, connect, identify, say };
}
