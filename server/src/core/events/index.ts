import type { Clock } from "../clock/index.ts";
import { ProtocolError } from "../errors/index.ts";
import type { Redactor } from "../redact/index.ts";

const CURSOR = /^c_([0-9a-z]+)$/;

/** An append-only list read by cursor: "what's new since my last read". */
export class CursorList<T> {
  readonly #items: T[] = [];

  append(item: T): T {
    this.#items.push(item);
    return item;
  }

  /** Everything after `since` (all of it without one), and the cursor for the next read. */
  read(since?: string): { items: T[]; cursor: string } {
    let from = 0;
    if (since !== undefined) {
      const match = CURSOR.exec(since);
      if (!match?.[1]) throw new ProtocolError("invalid_argument", "Not a cursor from this server", { since });
      from = Math.min(Number.parseInt(match[1], 36), this.#items.length);
    }
    return { items: this.#items.slice(from), cursor: `c_${this.#items.length.toString(36)}` };
  }
}

export type EventKind = "action" | "delivery" | "delivery_attempt" | "api_call";

export interface LogEvent {
  readonly at: string;
  readonly driver: string;
  readonly kind: EventKind;
  readonly data: Record<string, unknown>;
}

/** The event log: per session, append-only. Tokens are scrubbed before anything is recorded. */
export class EventLog {
  readonly #clock: Clock;
  readonly #redactor: Redactor;
  readonly #logs = new Map<string, CursorList<LogEvent>>();

  constructor(clock: Clock, redactor: Redactor) {
    this.#clock = clock;
    this.#redactor = redactor;
  }

  append(session: string, driver: string, kind: EventKind, data: Record<string, unknown>): void {
    let log = this.#logs.get(session);
    if (!log) {
      log = new CursorList();
      this.#logs.set(session, log);
    }
    log.append({ at: new Date(this.#clock()).toISOString(), driver, kind, data: this.#redactor.tokens(data) });
  }

  read(session: string, since?: string): { events: LogEvent[]; cursor: string } {
    const { items, cursor } = (this.#logs.get(session) ?? new CursorList<LogEvent>()).read(since);
    return { events: items, cursor };
  }

  drop(session: string): void {
    this.#logs.delete(session);
  }
}
