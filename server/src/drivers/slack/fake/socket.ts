import type { DeliveryRequest, DeliveryTransport } from "../../../core/delivery/index.ts";
import type { DriverContext, SocketPeer, SocketSession } from "../../../core/router/index.ts";
import { randomToken } from "../../../core/secrets/index.ts";
import { OpenConnections } from "../../../core/socket/index.ts";
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

export interface SocketMode {
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

/**
 * Slack's Socket Mode: the app opens a WebSocket and receives events, interactions and commands
 * as envelopes on it, acknowledging each one, optionally with an answer.
 */
export function createSocketMode(context: DriverContext, appId: () => string): SocketMode {
  const { ids, clock } = context;
  const tickets = new Map<string, number>();
  const peers = new OpenConnections<SocketPeer>();
  /** Envelopes sent and not yet acknowledged, by `envelope_id`. */
  const awaiting = new Map<string, (payload: unknown) => void>();
  let chosen = false;
  /** When the app last had, or asked for, a connection: an app that reconnects does so within seconds. */
  let lastSeen = 0;
  /** An app that also has a request URL counts as back on HTTP once it has held no socket for this long. */
  const backOnHttp = () =>
    context.webhookUrl !== undefined && peers.size === 0 && clock() - lastSeen > RECONNECT_WINDOW_MS;

  const url = () => `${context.apiUrl().replace(/^http/, "ws")}/link`;

  const send: DeliveryTransport["send"] = async ({ request, headers, signal }) => {
    const peer = await peers.next(signal);
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
          peer.send(
            JSON.stringify({
              type: "hello",
              num_connections: peers.size + 1,
              debug_info: { host: "channelstack", build_number: 1, approximate_connection_time: 18_060 },
              connection_info: { app_id: appId() },
            }),
          );
          peers.add(peer);
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
      for (const peer of peers.drain()) peer.close();
      lastSeen = clock();
    },
  };
}
