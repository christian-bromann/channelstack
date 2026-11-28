import type { DeliveryTransport } from "../../../core/delivery/index.ts";
import type { DriverContext, SocketPeer, SocketSession } from "../../../core/router/index.ts";
import { OpenConnections } from "../../../core/socket/index.ts";
import { DISCORD_IDS } from "../ids.ts";

/** Discord's Gateway opcodes. */
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
  RECONNECT: 7,
  REQUEST_GUILD_MEMBERS: 8,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** Discord's Gateway close codes the fake closes with. */
const CLOSE = {
  UNKNOWN_OPCODE: 4001,
  DECODE_ERROR: 4002,
  NOT_AUTHENTICATED: 4003,
  AUTHENTICATION_FAILED: 4004,
  ALREADY_AUTHENTICATED: 4005,
  INVALID_API_VERSION: 4012,
  INVALID_INTENTS: 4013,
  DISALLOWED_INTENTS: 4014,
} as const;

/** The Gateway intents, by name. */
export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MODERATION: 1 << 2,
  GUILD_EXPRESSIONS: 1 << 3,
  GUILD_INTEGRATIONS: 1 << 4,
  GUILD_WEBHOOKS: 1 << 5,
  GUILD_INVITES: 1 << 6,
  GUILD_VOICE_STATES: 1 << 7,
  GUILD_PRESENCES: 1 << 8,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  GUILD_MESSAGE_TYPING: 1 << 11,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  DIRECT_MESSAGE_TYPING: 1 << 14,
  MESSAGE_CONTENT: 1 << 15,
  GUILD_SCHEDULED_EVENTS: 1 << 16,
  AUTO_MODERATION_CONFIGURATION: 1 << 20,
  AUTO_MODERATION_EXECUTION: 1 << 21,
  GUILD_MESSAGE_POLLS: 1 << 24,
  DIRECT_MESSAGE_POLLS: 1 << 25,
} as const;

export type Intent = keyof typeof INTENTS;

const ALL_INTENTS = Object.values(INTENTS).reduce((all, bit) => all | bit, 0);
/** The intents an app must switch on in the developer portal before it may ask for them. */
const PRIVILEGED: readonly Intent[] = ["GUILD_MEMBERS", "GUILD_PRESENCES", "MESSAGE_CONTENT"];

/** Discord asks for a heartbeat every 41.25 seconds. */
const HEARTBEAT_INTERVAL_MS = 41_250;
/** How long a session that lost its connection can be resumed. */
const RESUME_WINDOW_MS = 5 * 60_000;
/** The most dispatches a session keeps for a RESUME; past that it can't be resumed. */
const REPLAY_LIMIT = 2000;
/** The largest payload the Gateway takes from a client: 4096 bytes. */
const MAX_PAYLOAD = 4096;

interface Dispatched {
  readonly s: number;
  readonly t: string;
  readonly d: unknown;
}

/** A Gateway session: the app whose bot identified, with which intents, and what was dispatched to it, for a RESUME. */
interface GatewaySession {
  readonly id: string;
  /** The app whose token identified it, by name. */
  readonly app: string;
  readonly intents: number;
  seq: number;
  readonly sent: Dispatched[];
  /** Too much was dispatched while it was away: it can't be resumed. */
  overflowed: boolean;
  peer: SocketPeer | undefined;
  /** When it last lost its connection. */
  leftAt: number | undefined;
}

/** One app's bot on the Gateway: its connections, and how dispatches reach them. */
interface Gateway {
  /** How many connections are identified (or resumed) and receive dispatches. */
  connections(): number;
  /** The intents of the bot's newest session, or undefined before it has identified. */
  intents(): number | undefined;
  /** How deliveries reach the bot: over its newest session, waiting for one while there is none. */
  transport(): DeliveryTransport;
}

/**
 * Every app's bot on the one Gateway (decision 0027): each identifies with its own token, and
 * gets only its own dispatches, on its own sessions.
 */
export interface Gateways {
  /** Where every bot connects, as `GET /gateway/bot` gives it. */
  url(): string;
  /** A WebSocket request from a bot: the connection, at the Gateway's path. Which bot it is, IDENTIFY says. */
  accept(request: Request): SocketSession | undefined;
  /** An app's bot, by the app's name. */
  of(app: string): Gateway;
  /** Forget every session: a reset. */
  reset(): void;
}

/** What the Gateway needs of the world: the apps and their tokens, and what a new session is sent. */
export interface GatewayWorld {
  /** The name of the app whose bot token this is, if any: its bot may identify. */
  appWithToken(token: string): string | undefined;
  /** The privileged intents the app has switched on. */
  privilegedIntents(app: string): readonly string[];
  /** READY's `d`, for a new session of this app's bot. */
  ready(app: string, session: string, resumeUrl: string): Record<string, unknown>;
  /** Whether a test session asked for a drop before its next dispatch: if so, it is taken (it fires once). */
  takeDrop(session: string): boolean;
  /** What is dispatched right after READY: the guild, as GUILD_CREATE, as this app's bot sees it. */
  afterReady(app: string): Array<{ t: string; d: unknown }>;
}

const parse = (text: string): { op?: unknown; d?: unknown } | undefined => {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/** One bot's sessions with a connection, newest last, and its newest session, connected or not. */
interface BotSessions {
  readonly live: OpenConnections<GatewaySession>;
  newest: GatewaySession | undefined;
}

/**
 * Discord's Gateway: a bot opens a WebSocket, identifies with its token and intents, and from
 * then on gets every event as a dispatch with a sequence number; after a drop it resumes and is
 * sent what it missed. There is no acknowledgement: a dispatch is delivered once it is written.
 */
export function createGateways(context: DriverContext, world: GatewayWorld): Gateways {
  const { ids, clock } = context;
  const sessions = new Map<string, GatewaySession>();
  /** Each app's bot: where its dispatches go, by app name. */
  const bots = new Map<string, BotSessions>();
  const botOf = (app: string): BotSessions => {
    let bot = bots.get(app);
    if (!bot) {
      bot = { live: new OpenConnections<GatewaySession>(), newest: undefined };
      bots.set(app, bot);
    }
    return bot;
  };

  const url = () => `${context.apiUrl().replace(/^http/, "ws")}/gateway`;
  const resumable = (session: GatewaySession) =>
    !session.overflowed && (session.peer !== undefined || clock() - (session.leftAt ?? 0) <= RESUME_WINDOW_MS);

  /** The app a token is the bot token of, compared in constant time. */
  const appWithToken = (token: unknown): string | undefined =>
    typeof token === "string" ? world.appWithToken(token.replace(/^Bot /, "")) : undefined;

  const send = (session: GatewaySession, payload: Record<string, unknown>) =>
    session.peer?.send(JSON.stringify(payload));

  /** Dispatch an event on a session: the next sequence number, kept for a RESUME, sent if it is connected. */
  const dispatch = (session: GatewaySession, t: string, d: unknown, cause?: string) => {
    session.seq += 1;
    const entry = { s: session.seq, t, d };
    session.sent.push(entry);
    if (session.sent.length > REPLAY_LIMIT) {
      session.sent.shift();
      if (session.peer === undefined) session.overflowed = true;
    }
    // A test session's `drop_gateway`: the connection drops just before its next dispatch, which a resuming bot still gets.
    if (cause !== undefined && session.peer && world.takeDrop(cause)) {
      const peer = session.peer;
      leave(session);
      peer.close();
      return;
    }
    send(session, { op: OP.DISPATCH, ...entry });
  };

  const leave = (session: GatewaySession) => {
    botOf(session.app).live.delete(session);
    session.peer = undefined;
    session.leftAt = clock();
  };

  const gatewayOf = (app: string): Gateway => {
    const bot = botOf(app);
    const transport: DeliveryTransport = {
      get url() {
        return url();
      },
      async send({ request, signal }) {
        // A session the bot can still resume keeps what it misses; with none, the delivery waits for the bot to connect.
        const session = bot.newest && resumable(bot.newest) ? bot.newest : await bot.live.next(signal);
        dispatch(session, request.type, request.meta?.payload, request.session);
        return { contentType: "application/json", body: "" };
      },
    };
    return {
      connections: () => bot.live.size,
      intents: () => bot.newest?.intents,
      transport: () => transport,
    };
  };
  const gateways = new Map<string, Gateway>();

  return {
    url,
    of(app) {
      let gateway = gateways.get(app);
      if (!gateway) {
        gateway = gatewayOf(app);
        gateways.set(app, gateway);
      }
      return gateway;
    },

    accept(request) {
      const { pathname, searchParams } = new URL(request.url);
      if (!/\/gateway\/?$/.test(pathname)) return undefined;
      let peer: SocketPeer | undefined;
      let session: GatewaySession | undefined;
      const close = (code: number, reason: string) => peer?.close(code, reason);

      const identify = (d: Record<string, unknown>) => {
        if (session) return close(CLOSE.ALREADY_AUTHENTICATED, "Already authenticated.");
        // Which bot this is, its token says: each app's bot gets its own sessions and dispatches.
        const app = appWithToken(d.token);
        if (app === undefined) return close(CLOSE.AUTHENTICATION_FAILED, "Authentication failed.");
        const intents = d.intents;
        if (
          typeof intents !== "number" ||
          !Number.isInteger(intents) ||
          intents < 0 ||
          (intents & ~ALL_INTENTS) !== 0
        ) {
          return close(CLOSE.INVALID_INTENTS, "Invalid intent(s).");
        }
        const allowed = world.privilegedIntents(app);
        if (PRIVILEGED.some((name) => (intents & INTENTS[name]) !== 0 && !allowed.includes(name))) {
          return close(CLOSE.DISALLOWED_INTENTS, "Disallowed intent(s).");
        }
        const id = ids.next(DISCORD_IDS.session);
        const created: GatewaySession = {
          id,
          app,
          intents,
          seq: 0,
          sent: [],
          overflowed: false,
          peer,
          leftAt: undefined,
        };
        sessions.set(id, created);
        session = created;
        botOf(app).newest = created;
        dispatch(created, "READY", world.ready(app, id, url()));
        for (const event of world.afterReady(app)) dispatch(created, event.t, event.d);
        botOf(app).live.add(created);
      };

      const resume = (d: Record<string, unknown>) => {
        if (session) return close(CLOSE.ALREADY_AUTHENTICATED, "Already authenticated.");
        const app = appWithToken(d.token);
        if (app === undefined) return close(CLOSE.AUTHENTICATION_FAILED, "Authentication failed.");
        const found = typeof d.session_id === "string" ? sessions.get(d.session_id) : undefined;
        const seq = typeof d.seq === "number" ? d.seq : -1;
        const oldest = found?.sent[0]?.s ?? 1;
        // A session is its bot's: another bot's token can't resume it.
        if (!found || found.app !== app || !resumable(found) || seq > found.seq || seq < oldest - 1) {
          // Discord: the session can't be resumed; identify again.
          peer?.send(JSON.stringify({ op: OP.INVALID_SESSION, d: false }));
          return undefined;
        }
        // A session belongs to one connection: an old one that is still open is closed.
        if (found.peer && found.peer !== peer) found.peer.close(4000, "Session resumed elsewhere.");
        found.peer = peer;
        found.leftAt = undefined;
        session = found;
        botOf(app).newest = found;
        for (const missed of found.sent.filter((entry) => entry.s > seq)) send(found, { op: OP.DISPATCH, ...missed });
        dispatch(found, "RESUMED", null);
        botOf(app).live.add(found);
        return undefined;
      };

      const unsupported =
        (searchParams.get("v") !== null && !["9", "10"].includes(searchParams.get("v") ?? "")) ||
        (searchParams.get("encoding") ?? "json") !== "json" ||
        searchParams.get("compress") !== null;

      return {
        open(opened) {
          peer = opened;
          // The fake speaks JSON without compression, as v10 does without `compress`.
          if (unsupported) return void opened.close(CLOSE.INVALID_API_VERSION, "Invalid API version or encoding.");
          opened.send(JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: HEARTBEAT_INTERVAL_MS, _trace: [] } }));
        },
        message(text) {
          const payload = text.length > MAX_PAYLOAD ? undefined : parse(text);
          if (!payload || typeof payload.op !== "number")
            return close(CLOSE.DECODE_ERROR, "Error while decoding payload.");
          const d = typeof payload.d === "object" && payload.d !== null ? (payload.d as Record<string, unknown>) : {};
          switch (payload.op) {
            case OP.HEARTBEAT:
              return void peer?.send(JSON.stringify({ op: OP.HEARTBEAT_ACK }));
            case OP.IDENTIFY:
              return identify(d);
            case OP.RESUME:
              return resume(d);
            case OP.PRESENCE_UPDATE:
            case OP.VOICE_STATE_UPDATE:
            case OP.REQUEST_GUILD_MEMBERS:
              if (!session) return close(CLOSE.NOT_AUTHENTICATED, "Not authenticated.");
              return undefined;
            default:
              return close(CLOSE.UNKNOWN_OPCODE, "Unknown opcode.");
          }
        },
        closed() {
          if (session && session.peer === peer) leave(session);
        },
      };
    },

    reset() {
      for (const bot of bots.values()) {
        for (const session of bot.live.drain()) session.peer?.close(4000, "Unknown error.");
        bot.newest = undefined;
      }
      sessions.clear();
    },
  };
}
