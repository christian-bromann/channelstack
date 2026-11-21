import type { Clock, Timers } from "../clock/index.ts";
import { ProtocolError } from "../errors/index.ts";
import type { EventLog } from "../events/index.ts";
import type { Logger } from "../log/index.ts";

type DeliveryStatus = "pending" | "acknowledged" | "failed" | "timed_out" | "unreachable";

export interface DeliveryRequest {
  /** The platform's id for this delivery. */
  readonly id: string;
  readonly session: string;
  readonly driver: string;
  /** The platform's event type. */
  readonly type: string;
  readonly url: string;
  /** The exact bytes to send. Signatures are computed over these. */
  readonly body: string;
  /** The body's content type. Default: JSON. */
  readonly contentType?: string;
  /** The platform's signature headers for this body, signed when the attempt is sent. */
  sign(body: string, atMs: number): Record<string, string>;
  /** The platform's ack window. */
  readonly timeoutMs: number;
  /** What the driver wants to find again on the delivery: the inner event type, the object that caused it. */
  readonly meta?: Readonly<Record<string, unknown>>;
  /** How the platform retries a delivery the agent didn't acknowledge. Without it, there is one attempt. */
  readonly retry?: RetryPolicy;
}

/** A platform's own retry behaviour, asked after each attempt of the chain it started itself. */
export interface RetryPolicy {
  /**
   * The next retry after an attempt that wasn't acknowledged: when, and with which headers.
   * `retries` counts the retries already sent. Undefined ends the chain: the platform gives up,
   * or the agent's response told it not to retry.
   */
  next(
    attempt: DeliveryAttempt,
    retries: number,
    responseHeaders: Headers | undefined,
  ): { afterMs: number; headers: Record<string, string> } | undefined;
}

/** One attempt to deliver, as `api/common.d.ts` describes it. */
export interface DeliveryAttempt {
  readonly number: number;
  readonly sentAt: string;
  readonly transport: "http";
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly status: DeliveryStatus;
  readonly responseStatus?: number;
  readonly responseBody?: string;
  readonly durationMs?: number;
  /** True when this attempt was sent with a deliberately wrong signature. */
  readonly forgedSignature: boolean;
}

/** A delivery with every attempt so far. */
export interface DeliveryRecord {
  readonly request: DeliveryRequest;
  readonly attempts: DeliveryAttempt[];
  /** Calls off the retry the platform has scheduled, while one is. */
  cancelRetry?: (() => void) | undefined;
}

/** How a later attempt differs from the first: what a platform's retry, or a test's forged delivery, changes. */
export interface AttemptOptions {
  /** Extra headers, such as the platform's retry headers. */
  headers?: Readonly<Record<string, string>>;
  /** Sign with this instead of the delivery's own signer: a wrong secret, or a stale timestamp. */
  sign?: (body: string, atMs: number) => Record<string, string>;
  /** Marks the attempt as deliberately forged. */
  forged?: boolean;
}

const RESPONSE_BODY_LIMIT = 2048;

/**
 * Sends events to the agent and keeps every delivery with its attempts. Drivers hand it a
 * payload and a signer; nothing else in the server calls the agent.
 */
export class DeliveryQueue {
  readonly #events: EventLog;
  readonly #clock: Clock;
  readonly #timers: Timers;
  readonly #log: Logger;
  readonly #inFlight = new Set<Promise<unknown>>();
  /** Per session: its deliveries, and the switch that aborts the ones in flight when it closes. */
  readonly #sessions = new Map<string, { canceller: AbortController; records: Map<string, DeliveryRecord> }>();

  constructor(deps: { events: EventLog; clock: Clock; timers: Timers; log: Logger }) {
    this.#events = deps.events;
    this.#clock = deps.clock;
    this.#timers = deps.timers;
    this.#log = deps.log;
  }

  /** Record a delivery and send its first attempt. */
  enqueue(request: DeliveryRequest): DeliveryRecord {
    const { id, session, driver, type, url } = request;
    const record: DeliveryRecord = { request, attempts: [] };
    this.#session(session).records.set(id, record);
    this.#events.append(session, driver, "delivery", { id, type, url, ...(request.meta ?? {}) });
    this.#track(this.#chain(record, {}, 0));
    return record;
  }

  /**
   * One attempt of the chain the platform runs by itself: the first delivery, then its retries
   * for as long as the platform's policy asks for one. Attempts a test sends (`again`) are not part of it.
   */
  async #chain(record: DeliveryRecord, options: AttemptOptions, retries: number): Promise<void> {
    const { attempt, responseHeaders } = await this.#send(record, options);
    const cancelled = this.#sessions.get(record.request.session)?.records.get(record.request.id) !== record;
    if (cancelled || attempt.status === "acknowledged") return;
    const next = record.request.retry?.next(attempt, retries, responseHeaders);
    if (!next) return;
    record.cancelRetry = this.#timers.after(next.afterMs, () => {
      record.cancelRetry = undefined;
      this.#track(this.#chain(record, { headers: next.headers }, retries + 1));
    });
  }

  /** Send a delivery again: a platform retry, a redelivery, or a forged copy. Resolves with the new attempt. */
  again(session: string, id: string, options: AttemptOptions = {}): Promise<DeliveryAttempt> {
    return this.#track(this.#send(this.get(session, id), options).then(({ attempt }) => attempt));
  }

  get(session: string, id: string): DeliveryRecord {
    const record = this.#sessions.get(session)?.records.get(id);
    if (!record) throw new ProtocolError("not_found", `No delivery "${id}" in this session`, { delivery: id });
    return record;
  }

  list(session: string): DeliveryRecord[] {
    return [...(this.#sessions.get(session)?.records.values() ?? [])];
  }

  /** Deliveries with an attempt still in flight or a retry scheduled, across all sessions or for one. */
  pending(session?: string): number {
    const sessions = session === undefined ? [...this.#sessions.values()] : [this.#sessions.get(session)];
    return sessions
      .flatMap((entry) => [...(entry?.records.values() ?? [])])
      .filter(
        (record) => record.cancelRetry !== undefined || record.attempts.some((attempt) => attempt.status === "pending"),
      ).length;
  }

  /**
   * Forget a closed session's deliveries and abort the ones in flight. Nothing more is sent or
   * recorded for it, so its event log stays gone.
   */
  cancel(session: string): void {
    const entry = this.#sessions.get(session);
    for (const record of entry?.records.values() ?? []) record.cancelRetry?.();
    entry?.canceller.abort();
    this.#sessions.delete(session);
  }

  /** Resolves once no attempt is in flight. */
  async settled(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled(this.#inFlight);
  }

  #session(session: string) {
    let entry = this.#sessions.get(session);
    if (!entry) {
      entry = { canceller: new AbortController(), records: new Map() };
      this.#sessions.set(session, entry);
    }
    return entry;
  }

  #track<T>(work: Promise<T>): Promise<T> {
    const tracked = work.finally(() => this.#inFlight.delete(tracked));
    this.#inFlight.add(tracked);
    // A rejection belongs to whoever awaits the attempt; an unawaited first attempt never rejects.
    tracked.catch(() => {});
    return tracked;
  }

  async #send(
    record: DeliveryRecord,
    options: AttemptOptions,
  ): Promise<{ attempt: DeliveryAttempt; responseHeaders: Headers | undefined }> {
    const { request } = record;
    const cancelled = this.#session(request.session).canceller.signal;
    const sentAt = this.#clock();
    const requestHeaders = {
      "content-type": request.contentType ?? "application/json",
      "user-agent": "channelstack",
      ...(options.sign ?? request.sign)(request.body, sentAt),
      ...options.headers,
    };
    const index = record.attempts.length;
    const started = {
      number: index + 1,
      sentAt: new Date(sentAt).toISOString(),
      transport: "http" as const,
      url: request.url,
      requestHeaders,
      forgedSignature: options.forged === true,
    };
    record.attempts.push({ ...started, status: "pending" });

    let outcome: Pick<DeliveryAttempt, "status" | "responseStatus" | "responseBody">;
    let responseHeaders: Headers | undefined;
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: requestHeaders,
        body: request.body,
        redirect: "manual",
        signal: AbortSignal.any([AbortSignal.timeout(request.timeoutMs), cancelled]),
      });
      responseHeaders = response.headers;
      const responseBody = (await response.text()).slice(0, RESPONSE_BODY_LIMIT);
      outcome = { status: response.ok ? "acknowledged" : "failed", responseStatus: response.status, responseBody };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      outcome = { status: name === "TimeoutError" || name === "AbortError" ? "timed_out" : "unreachable" };
    }
    const attempt: DeliveryAttempt = { ...started, ...outcome, durationMs: this.#clock() - sentAt };
    if (cancelled.aborted) return { attempt, responseHeaders };
    record.attempts[index] = attempt;
    this.#events.append(request.session, request.driver, "delivery_attempt", { id: request.id, ...attempt });
    this.#log.debug("delivery attempt", { id: request.id, driver: request.driver, type: request.type, ...outcome });
    return { attempt, responseHeaders };
  }
}
