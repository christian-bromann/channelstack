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

/** An event in one line, for `channelstack tail` and the UI's inspector. */
interface EventSummary {
  /** What went where: `→ slack app_mention` (to the agent), `← slack chat.postMessage` (from it). */
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

/** The one-line summary of an event. `deliveryType` is what the delivery it belongs to carried. */
function summarize(
  driver: string,
  kind: EventKind,
  data: Record<string, unknown>,
  deliveryType: unknown,
): EventSummary | undefined {
  if (kind === "delivery_attempt") {
    const ok = data.status === "acknowledged";
    const retry = data.number === 1 ? "" : ` (attempt ${data.number})`;
    return {
      text: `→ ${driver} ${deliveryType ?? "event"}${retry}`,
      outcome: ok ? String(data.responseStatus) : String(data.status),
      ok,
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
  readonly #deliveryTypes = new Map<string, Map<unknown, unknown>>();
  readonly #listeners: Array<(session: string) => void> = [];

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
    let types = this.#deliveryTypes.get(session);
    if (!types) {
      types = new Map();
      this.#deliveryTypes.set(session, types);
    }
    if (kind === "delivery") types.set(data.id, data.eventType ?? data.type);
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

  read(session: string, since?: string): { events: LogEvent[]; cursor: string } {
    const { items, cursor } = (this.#logs.get(session) ?? new CursorList<LogEvent>()).read(since);
    return { events: items, cursor };
  }

  drop(session: string): void {
    this.#logs.delete(session);
    this.#deliveryTypes.delete(session);
  }
}
