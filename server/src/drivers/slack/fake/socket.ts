import type { DeliveryRequest, DeliveryTransport } from "../../../core/delivery/index.ts";
import type { DriverContext, SocketPeer, SocketSession } from "../../../core/router/index.ts";
import { randomToken } from "../../../core/secrets/index.ts";
import { SLACK_IDS } from "../ids.ts";

/** How long a ticket from `apps.connections.open` is good for. */
const TICKET_LIFETIME_MS = 30_000;
/** How long deliveries wait for a Socket Mode app to reconnect before its request URL is used again. */
const RECONNECT_WINDOW_MS = 30_000;

/** The envelope type Socket Mode wraps each kind of delivery in. */
const ENVELOPE_TYPE: Readonly<Record<string, string>> = {
  event_callback: "events_api",
  slash_command: "slash_commands",
};

/** The kinds the app may answer in its acknowledgement: a command's reply, a submission's `response_action`. */
const ANSWERED_IN_ACK = new Set(["slash_command", "view_submission", "block_actions", "message_action"]);

interface SocketMode {
  /** `apps.connections.open`: the WebSocket URL for one connection, with a ticket that works once. */
  ticket(): string;
  /** A WebSocket request from the agent: the connection, if it comes with a ticket this fake issued. */
  accept(request: Request): SocketSession | undefined;
  /** How many connections the app holds open right now. */
  connections(): number;
  /**
   * The way to the app, once it has chosen Socket Mode by asking for a connection: deliveries go
   * over its WebSocket from then on, not to its request URL.
   */
  transport(): DeliveryTransport | undefined;
  /** Cut every connection without a goodbye, the way a network drop does. The app is expected to reconnect. */
  drop(): void;
}

/** Every app's Socket Mode: each app opens its own connections with its own app token, and gets only its own envelopes. */
export interface SocketModes {
  /** The app's Socket Mode, made the first time it is asked for. */
  of(app: { readonly id: string; readonly name: string }): SocketMode;
  /** A WebSocket request from an agent: the connection of whichever app issued its ticket. */
  accept(request: Request): SocketSession | undefined;
}

export function createSocketModes(context: DriverContext): SocketModes {
  const modes = new Map<string, SocketMode>();
  return {
    of(app) {
      let mode = modes.get(app.name);
      if (!mode) {
        mode = createSocketMode(context, app.name, () => app.id);
        modes.set(app.name, mode);
      }
      return mode;
    },
    accept(request) {
      for (const mode of modes.values()) {
        const session = mode.accept(request);
        if (session) return session;
      }
      return undefined;
    },
  };
}

/**
 * Slack's Socket Mode for one app: the app opens a WebSocket and receives events, interactions
 * and commands as envelopes on it, acknowledging each one, optionally with an answer.
 */
function createSocketMode(context: DriverContext, appName: string, appId: () => string): SocketMode {
  const { ids, clock } = context;
  const tickets = new Map<string, number>();
  const peers = new Set<SocketPeer>();
  /** Envelopes sent and not yet acknowledged, by `envelope_id`. */
  const awaiting = new Map<string, (payload: unknown) => void>();
  /** Attempts waiting for the app to (re)connect. */
  let waiting: Array<() => void> = [];
  let chosen = false;
  /** When the app last had, or asked for, a connection: an app that reconnects does so within seconds. */
  let lastSeen = 0;
  /** An app that also has a request URL counts as back on HTTP once it has held no socket for this long. */
  const backOnHttp = () =>
    context.apps.webhookUrl(appName) !== undefined && peers.size === 0 && clock() - lastSeen > RECONNECT_WINDOW_MS;

  const url = () => `${context.apiUrl().replace(/^http/, "ws")}/link`;

  /** Resolves with a connection, waiting for the app to connect if it has none right now. */
  const connection = (signal: AbortSignal): Promise<SocketPeer> =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const ready = () => {
        const [peer] = [...peers].slice(-1);
        if (!peer) return false;
        resolve(peer);
        return true;
      };
      if (ready()) return;
      const retry = () => void ready();
      waiting.push(retry);
      signal.addEventListener(
        "abort",
        () => {
          waiting = waiting.filter((other) => other !== retry);
          reject(signal.reason);
        },
        { once: true },
      );
    });

  const send: DeliveryTransport["send"] = async ({ request, headers, signal }) => {
    const peer = await connection(signal);
    const envelopeId = ids.next(SLACK_IDS.envelope);
    const acknowledged = new Promise<unknown>((resolve, reject) => {
      signal.throwIfAborted();
      awaiting.set(envelopeId, resolve);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    peer.send(JSON.stringify(envelope(envelopeId, request, headers)));
    try {
      const payload = await acknowledged;
      return { contentType: "application/json", body: payload === undefined ? "" : JSON.stringify(payload) };
    } finally {
      awaiting.delete(envelopeId);
    }
  };

  /** A delivery as Socket Mode carries it: the payload itself, not a signed HTTP body. */
  function envelope(envelopeId: string, request: DeliveryRequest, headers: Readonly<Record<string, string>>) {
    return {
      envelope_id: envelopeId,
      payload: request.meta?.payload,
      type: ENVELOPE_TYPE[request.type] ?? "interactive",
      accepts_response_payload: ANSWERED_IN_ACK.has(request.type),
      retry_attempt: Number(headers["x-slack-retry-num"] ?? 0),
      retry_reason: headers["x-slack-retry-reason"] ?? "",
    };
  }

  return {
    ticket() {
      chosen = true;
      lastSeen = clock();
      const ticket = randomToken(24);
      tickets.set(ticket, clock() + TICKET_LIFETIME_MS);
      return `${url()}/?ticket=${ticket}&app_id=${appId()}`;
    },

    accept(request) {
      const { pathname, searchParams } = new URL(request.url);
      const ticket = searchParams.get("ticket") ?? "";
      const expiresAt = tickets.get(ticket);
      if (!/\/link\/?$/.test(pathname) || expiresAt === undefined || expiresAt < clock()) return undefined;
      tickets.delete(ticket);
      let self: SocketPeer | undefined;
      return {
        open(peer) {
          self = peer;
          peers.add(peer);
          peer.send(
            JSON.stringify({
              type: "hello",
              num_connections: peers.size,
              debug_info: { host: "channelstack", build_number: 1, approximate_connection_time: 18_060 },
              connection_info: { app_id: appId() },
            }),
          );
          for (const retry of waiting.splice(0)) retry();
        },
        message(text) {
          let ack: { envelope_id?: unknown; payload?: unknown } | null;
          try {
            ack = JSON.parse(text) as typeof ack;
          } catch {
            return;
          }
          if (typeof ack === "object" && ack !== null && typeof ack.envelope_id === "string")
            awaiting.get(ack.envelope_id)?.(ack.payload);
        },
        closed() {
          if (self) peers.delete(self);
          lastSeen = clock();
        },
      };
    },

    connections: () => peers.size,

    // While the app is between connections, deliveries wait for it; one that stays away is reached at its request URL.
    transport: () => (chosen && !backOnHttp() ? { url: url(), send } : undefined),

    drop() {
      for (const peer of [...peers]) {
        peers.delete(peer);
        peer.close();
      }
      lastSeen = clock();
    },
  };
}
