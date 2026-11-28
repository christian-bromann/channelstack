import { BUILT_IN_APP } from "../apps/index.ts";
import type { Clock } from "../clock/index.ts";
import { ProtocolError } from "../errors/index.ts";
import type { Redactor } from "../redact/index.ts";

const CURSOR = /^c_([0-9a-z]+)$/;

/**
 * An append-only list read by cursor: "what's new since my last read". With a `limit`, it keeps
 * only the newest items; cursors still count every item ever appended, so a reader that fell
 * behind gets what is left and goes on from there.
 */
export class CursorList<T> {
  readonly #items: T[] = [];
  readonly #limit: number;
  /** How many of the oldest items were dropped to stay within the limit. */
  #dropped = 0;

  constructor(options: { limit?: number } = {}) {
    this.#limit = options.limit ?? Number.POSITIVE_INFINITY;
  }

  append(item: T): T {
    this.#items.push(item);
    if (this.#items.length > this.#limit) {
      const over = this.#items.length - this.#limit;
      this.#items.splice(0, over);
      this.#dropped += over;
    }
    return item;
  }

  /**
   * Everything after `since` (all that is kept without one), the cursor for the next read, and
   * `first`: the position of the first item among every item ever appended, so an item's number
   * stays the same when older ones are dropped.
   */
  read(since?: string): { items: T[]; cursor: string; first: number } {
    const end = this.#dropped + this.#items.length;
    let from = this.#dropped;
    if (since !== undefined) {
      const match = CURSOR.exec(since);
      if (!match?.[1]) throw new ProtocolError("invalid_argument", "Not a cursor from this server", { since });
      from = Math.min(Math.max(Number.parseInt(match[1], 36), this.#dropped), end);
    }
    return { items: this.#items.slice(from - this.#dropped), cursor: `c_${end.toString(36)}`, first: from };
  }
}

/**
 * The scope of what belongs to no session: an app's calls about nothing a session owns (a GitHub
 * App's own endpoints). It is a log like a session's, read the same way. No session's close ends
 * it, so it keeps only its newest `WORLD_SCOPE_LIMIT` events, and a reset empties it.
 */
export const WORLD_SCOPE = "world";
const WORLD_SCOPE_LIMIT = 10_000;

/** `bot_loop`: the loop guard stopped apps answering each other in a conversation (decision 0027). */
export type EventKind = "action" | "delivery" | "delivery_attempt" | "api_call" | "bot_loop";

/** An event in one line, for `channelstack tail` and the UI's inspector. */
interface EventSummary {
  /**
   * What went where: `→ slack app_mention` (to the agent), `→ slack app_mention to coder` (to
   * another app, decision 0027), `← slack chat.postMessage` (from it).
   */
  readonly text: string;
  /** How it went: the HTTP status, with the platform's error code or the delivery's fate when it failed. */
  readonly outcome: string;
  readonly ok: boolean;
}

export interface LogEvent {
  readonly at: string;
  readonly driver: string;
  readonly kind: EventKind;
  readonly data: Record<string, unknown>;
  /** Delivery attempts and API calls have a one-line summary. */
  readonly summary?: EventSummary;
}

/** What a delivery carried, announced once before its attempts, and the app it went to. */
interface Announced {
  readonly type: unknown;
  readonly app: unknown;
}

/** The one-line summary of an event. `delivery` is what the delivery it belongs to carried, and to whom. */
function summarize(
  driver: string,
  kind: EventKind,
  data: Record<string, unknown>,
  delivery: Announced | undefined,
): EventSummary | undefined {
  if (kind === "delivery_attempt") {
    const ok = data.status === "acknowledged";
    const retry = data.number === 1 ? "" : ` (attempt ${data.number})`;
    const to = delivery?.app === undefined || delivery.app === BUILT_IN_APP ? "" : ` to ${String(delivery.app)}`;
    return {
      text: `→ ${driver} ${delivery?.type ?? "event"}${to}${retry}`,
      outcome: ok ? String(data.responseStatus) : String(data.status),
      ok,
    };
  }
  if (kind === "bot_loop") {
    return {
      text: `■ ${driver} bot loop in ${String(data.conversation)}`,
      outcome: `stopped after ${String(data.messages)} app messages`,
      ok: false,
    };
  }
  if (kind === "api_call") {
    const ok = data.error === undefined;
    return {
      text: `← ${driver} ${data.operation}`,
      outcome: ok ? String(data.responseStatus) : `${data.responseStatus} ${data.error}`,
      ok,
    };
  }
  return undefined;
}

/** The event log: per session, append-only. Tokens are scrubbed before anything is recorded. */
export class EventLog {
  readonly #clock: Clock;
  readonly #redactor: Redactor;
  readonly #logs = new Map<string, CursorList<LogEvent>>();
  /** Per session: what each delivery carried, announced once before its attempts. */
  readonly #deliveryTypes = new Map<string, Map<unknown, Announced>>();
  readonly #listeners: Array<(session: string) => void> = [];

  constructor(clock: Clock, redactor: Redactor) {
    this.#clock = clock;
    this.#redactor = redactor;
  }

  append(session: string, driver: string, kind: EventKind, data: Record<string, unknown>): void {
    let log = this.#logs.get(session);
    if (!log) {
      log = new CursorList(session === WORLD_SCOPE ? { limit: WORLD_SCOPE_LIMIT } : {});
      this.#logs.set(session, log);
    }
    let types = this.#deliveryTypes.get(session);
    if (!types) {
      types = new Map();
      this.#deliveryTypes.set(session, types);
    }
    if (kind === "delivery") types.set(data.id, { type: data.eventType ?? data.type, app: data.app });
    const summary = summarize(driver, kind, data, types.get(data.id));
    log.append({
      at: new Date(this.#clock()).toISOString(),
      driver,
      kind,
      data: this.#redactor.tokens(data),
      ...(summary ? { summary } : {}),
    });
    for (const listener of this.#listeners) listener(session);
  }

  /** Hear about every event as it is recorded: how the quiet detector knows a session's last activity. */
  onAppend(listener: (session: string) => void): void {
    this.#listeners.push(listener);
  }

  /** A session's events after `since`, and `first`: the number of events before them, kept or dropped. */
  read(session: string, since?: string): { events: LogEvent[]; cursor: string; first: number } {
    const { items, cursor, first } = (this.#logs.get(session) ?? new CursorList<LogEvent>()).read(since);
    return { events: items, cursor, first };
  }

  drop(session: string): void {
    this.#logs.delete(session);
    this.#deliveryTypes.delete(session);
  }
}
