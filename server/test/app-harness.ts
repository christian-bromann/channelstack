import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import { type App, createApp, type LiveOptions, type ServerUrls } from "../src/app.ts";
import type { Timers } from "../src/core/clock/index.ts";
import { createLogger } from "../src/core/log/index.ts";
import { Redactor } from "../src/core/redact/index.ts";
import { Secrets } from "../src/core/secrets/index.ts";
import { secretSpecs, TOKEN_PATTERNS } from "../src/drivers/index.ts";

/** The UI page of the app a harness builds: enough to see what the server fills in. */
const UI_PAGE = '<script nonce="__NONCE__">const session = "__SESSION__";</script>';

/** The bearer token of the app a harness builds. */
export const TOKEN = "test-token-0123456789";

type Reply = Promise<{ status: number; body: any }>;

/** Timers a test moves itself: nothing scheduled runs until the test lets time pass. */
interface ManualTimers extends Timers {
  /** Let this much time pass, running what falls due, in order. */
  advance(ms: number): void;
  /** How many tasks are waiting. */
  waiting(): number;
}

function manualTimers(): ManualTimers {
  let now = 0;
  let tasks: Array<{ at: number; run: () => void }> = [];
  return {
    after(delayMs, run) {
      const task = { at: now + delayMs, run };
      tasks.push(task);
      return () => {
        tasks = tasks.filter((other) => other !== task);
      };
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const [next] = tasks.filter((task) => task.at <= until).sort((a, b) => a.at - b.at);
        if (!next) break;
        tasks = tasks.filter((task) => task !== next);
        now = next.at;
        next.run();
      }
      now = until;
    },
    waiting: () => tasks.length,
  };
}

export interface Harness {
  app: App;
  /** The app's timers: retries and pauses happen when the test advances them. */
  timers: ManualTimers;
  /** The app's clock: the real time, plus whatever the test let pass. */
  clock: { advance(ms: number): void; now(): number };
  secrets: Secrets;
  /** Every line the app logged. */
  logs: string[];
  /** Call the control API. Pass `token: null` to send no Authorization header. */
  call(method: string, path: string, body?: unknown, token?: string | null): Reply;
  /** Call a driver's fake provider API, as the agent would. `path` starts with the driver's name. */
  provider(
    method: string,
    path: string,
    body?: unknown,
    token?: string | null,
    headers?: Record<string, string>,
  ): Reply;
}

/**
 * The app as the unit tests drive it: built in memory, called through `fetch`, with no listener.
 * `live` makes drivers real, with a stub standing in for each platform (`apiBase`, `fetch`).
 */
export function harness(
  webhooks: Readonly<Record<string, string | undefined>> = {},
  options: { live?: LiveOptions; urls?: () => ServerUrls } = {},
): Harness {
  const secrets = Secrets.ephemeral(secretSpecs());
  const redactor = new Redactor(TOKEN_PATTERNS);
  redactor.register(TOKEN, ...secrets.all());
  const logs: string[] = [];
  const timers = manualTimers();
  let ahead = 0;
  const app = createApp({
    version: "0.0.0-test",
    token: TOKEN,
    seed: 1,
    secrets,
    redactor,
    log: createLogger({ level: "debug", redactor, write: (line) => logs.push(line) }),
    urls:
      options.urls ?? (() => ({ control: "http://127.0.0.1:4500", driver: (name) => `http://127.0.0.1:4500/${name}` })),
    webhooks,
    ui: UI_PAGE,
    timers,
    clock: () => Date.now() + ahead,
    ...(options.live ? { live: options.live } : {}),
  });
  const send = async (
    url: string,
    method: string,
    body: unknown,
    token: string | null | undefined,
    headers: Record<string, string> = {},
  ): Reply => {
    const response = await app.fetch(
      new Request(url, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  return {
    app,
    timers,
    clock: {
      advance(ms) {
        ahead += ms;
      },
      now: () => Date.now() + ahead,
    },
    secrets,
    logs,
    call: (method, path, body, token = TOKEN) =>
      send(`http://127.0.0.1:4500/_channelstack${path}`, method, body, token),
    provider: (method, path, body, token, headers) =>
      send(`http://127.0.0.1:4500/${path}`, method, body, token, headers),
  };
}

export interface RecordingAgent {
  /** Where the fake should deliver. */
  url: string;
  /** Every delivery received so far. */
  received: Array<{ headers: IncomingHttpHeaders; body: string }>;
  /** What the agent answers. Default: 200 "ok". */
  respond: (delivery: { headers: IncomingHttpHeaders; body: string }) => {
    status: number;
    body?: string;
    headers?: Record<string, string>;
    delayMs?: number;
  };
  close(): void;
}

/** A stand-in agent endpoint that records what the fake delivers to it. */
export async function recordingAgent(): Promise<RecordingAgent> {
  const agent: RecordingAgent = {
    url: "",
    received: [],
    respond: () => ({ status: 200, body: "ok" }),
    close: () => {},
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const delivery = { headers: request.headers, body };
      agent.received.push(delivery);
      const answer = agent.respond(delivery);
      setTimeout(() => response.writeHead(answer.status, answer.headers).end(answer.body ?? ""), answer.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  agent.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
  agent.close = () => {
    server.closeAllConnections();
    server.close();
  };
  return agent;
}

/** The error code a control API call was refused with, or "no error". */
export const refusal = (run: Promise<unknown>) =>
  run.then(
    () => "no error",
    (error: { body?: { error: string } }) => error.body?.error,
  );
