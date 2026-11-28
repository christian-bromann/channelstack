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
  /** The app it goes to (decision 0027): `my-agent`, or one a test made. */
  readonly app?: string;
  /** The platform's event type. */
  readonly type: string;
  readonly url: string;
  /** The exact bytes to send. Signatures are computed over these. */
  readonly body: string;
  /** The body's content type. Default: JSON. */
  readonly contentType?: string;
  /** The platform's signature headers for this body, signed when the attempt is sent. */
  sign(body: string, atMs: number): Record<string, string>;
  /**
   * The body as one attempt sends it, for a platform that puts the attempt into the signed body:
   * its time (Linear's `webhookTimestamp`) or its number, from 1 (Notion's `attempt_number`).
   * Without it every attempt sends `body` as it is.
   */
  stamp?(body: string, atMs: number, attempt: number): string;
  /** The platform's ack window. */
  readonly timeoutMs: number;
  /** What the driver wants to find again on the delivery: the inner event type, the object that caused it. */
  readonly meta?: Readonly<Record<string, unknown>>;
  /**
   * Another way to the agent than an HTTP request, asked for at every attempt: a connection the
   * agent opened itself (Slack's Socket Mode). Undefined sends over HTTP to `url`.
   */
  transport?(): DeliveryTransport | undefined;
  /** How the platform retries a delivery the agent didn't acknowledge. Without it, there is one attempt. */
  readonly retry?: RetryPolicy;
  /**
   * Called with the agent's answer when it acknowledges an attempt of the platform's own chain.
   * Some deliveries are answered in the response itself: a slash command's immediate reply, a
   * modal submission's `response_action`.
   */
  answered?(answer: { status: number; contentType: string; body: string }): void;
}

/** A way to the agent over a connection the agent holds open. */
export interface DeliveryTransport {
  /** Where the connection goes, for the record. */
  readonly url: string;
  /**
   * Send one attempt and resolve with what the agent acknowledged it with. Rejects when the agent
   * can't be reached; `signal` fires at the end of the ack window and when the session closes.
   */
  send(attempt: {
    request: DeliveryRequest;
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
  }): Promise<{ contentType: string; body: string }>;
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

/** One attempt to deliver, as a test reads it from a delivery's `attempts`. */
export interface DeliveryAttempt {
  readonly number: number;
  readonly sentAt: string;
  readonly transport: "http" | "socket";
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
  /** The retry the platform has scheduled, while one is: when it is due, and how to call it off. */
  retry?: { readonly at: number; cancel(): void } | undefined;
  /**
   * Resolves once the first attempt has its outcome (and an answer was handed on), for a platform
   * that acts on it right away: Discord's check of a new interactions endpoint.
   */
  sent?: Promise<void>;
}

/** How a later attempt differs from the first: what a platform's retry, or a test's forged delivery, changes. */
export interface AttemptOptions {
  /** Extra headers, such as the platform's retry headers. */
  headers?: Readonly<Record<string, string>>;
  /** Sign with this instead of the delivery's own signer: a wrong secret, or a stale timestamp. */
  sign?: (body: string, atMs: number) => Record<string, string>;
  /** Marks the attempt as deliberately forged. */
  forged?: boolean;
  /**
   * Send as if at this time: the body is stamped and signed with it. A time long past makes a
   * stale delivery the agent should refuse.
   */
  atMs?: number;
}

const RESPONSE_BODY_LIMIT = 2048;
/** How much of an agent's answer is handed to the driver that acts on it. */
const ANSWER_LIMIT = 256 * 1024;
/** A scheduled retry this close counts as work in progress; a later one doesn't. */
const RETRY_SOON_MS = 5000;

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

  readonly #observe: ((request: DeliveryRequest) => void) | undefined;

  /** `observe` sees every delivery as it is made: the recorder writes its shape (proxy mode's `--record`). */
  constructor(deps: {
    events: EventLog;
    clock: Clock;
    timers: Timers;
    log: Logger;
    observe?: (request: DeliveryRequest) => void;
  }) {
    this.#observe = deps.observe;
    this.#events = deps.events;
    this.#clock = deps.clock;
    this.#timers = deps.timers;
    this.#log = deps.log;
  }

  /** Record a delivery and send its first attempt. */
  enqueue(request: DeliveryRequest): DeliveryRecord {
    const { id, session, driver, type, url, app } = request;
    const record: DeliveryRecord = { request, attempts: [] };
    this.#observe?.(request);
    this.#session(session).records.set(id, record);
    // The event log says which app each delivery went to, so the inspector and `tail` tell two apps' apart.
    this.#events.append(session, driver, "delivery", {
      id,
      type,
      url,
      ...(request.meta ?? {}),
      ...(app === undefined ? {} : { app }),
    });
    record.sent = this.#track(this.#chain(record, {}, 0));
    return record;
  }

  /**
   * One attempt of the chain the platform runs by itself: the first delivery, then its retries
   * for as long as the platform's policy asks for one. Attempts a test sends (`again`) are not part of it.
   */
  async #chain(record: DeliveryRecord, options: AttemptOptions, retries: number): Promise<void> {
    const { attempt, responseHeaders, responseText } = await this.#send(record, options);
    const cancelled = this.#sessions.get(record.request.session)?.records.get(record.request.id) !== record;
    if (cancelled) return;
    if (attempt.status === "acknowledged") {
      try {
        record.request.answered?.({
          status: attempt.responseStatus ?? 200,
          contentType: responseHeaders?.get("content-type") ?? "",
          body: responseText ?? "",
        });
      } catch (error) {
        // The agent acknowledged with something the platform can't act on (a view that isn't one, a
        // reply it refuses). The delivery stands; what went wrong is in the log and the event log.
        const problem = error instanceof Error ? error.message : String(error);
        this.#log.warn("the agent's answer could not be acted on", { id: record.request.id, problem });
        this.#events.append(record.request.session, record.request.driver, "action", {
          action: "answer_refused",
          delivery: record.request.id,
          problem,
        });
      }
      return;
    }
    const next = record.request.retry?.next(attempt, retries, responseHeaders);
    if (!next) return;
    const cancel = this.#timers.after(next.afterMs, () => {
      record.retry = undefined;
      this.#track(this.#chain(record, { headers: next.headers }, retries + 1));
    });
    record.retry = { at: this.#clock() + next.afterMs, cancel };
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

  /**
   * Deliveries the agent is about to hear from: an attempt in flight, or a retry due within
   * moments. A retry a minute or more away doesn't count: the agent is quiet until then, and a
   * check shouldn't wait minutes for a delivery the agent already failed.
   */
  pending(session?: string): number {
    const sessions = session === undefined ? [...this.#sessions.values()] : [this.#sessions.get(session)];
    const soon = this.#clock() + RETRY_SOON_MS;
    return sessions
      .flatMap((entry) => [...(entry?.records.values() ?? [])])
      .filter(
        (record) =>
          (record.retry !== undefined && record.retry.at <= soon) ||
          record.attempts.some((attempt) => attempt.status === "pending"),
      ).length;
  }

  /**
   * Forget a closed session's deliveries and abort the ones in flight. Nothing more is sent or
   * recorded for it, so its event log stays gone.
   */
  cancel(session: string): void {
    const entry = this.#sessions.get(session);
    for (const record of entry?.records.values() ?? []) record.retry?.cancel();
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
  ): Promise<{ attempt: DeliveryAttempt; responseHeaders: Headers | undefined; responseText?: string }> {
    const { request } = record;
    const cancelled = this.#session(request.session).canceller.signal;
    const sentAt = this.#clock();
    const transport = request.transport?.();
    const at = options.atMs ?? sentAt;
    const body = request.stamp ? request.stamp(request.body, at, record.attempts.length + 1) : request.body;
    const requestHeaders = transport
      ? // A connection the agent opened needs no signature: only what the platform adds to a retry.
        { ...options.headers }
      : {
          "content-type": request.contentType ?? "application/json",
          "user-agent": "channelstack",
          ...(options.sign ?? request.sign)(body, at),
          ...options.headers,
        };
    const index = record.attempts.length;
    const started = {
      number: index + 1,
      sentAt: new Date(sentAt).toISOString(),
      transport: transport ? ("socket" as const) : ("http" as const),
      url: transport?.url ?? request.url,
      requestHeaders,
      forgedSignature: options.forged === true,
    };
    record.attempts.push({ ...started, status: "pending" });

    let outcome: Pick<DeliveryAttempt, "status" | "responseStatus" | "responseBody">;
    let responseHeaders: Headers | undefined;
    let responseText: string | undefined;
    const signal = AbortSignal.any([AbortSignal.timeout(request.timeoutMs), cancelled]);
    try {
      if (transport) {
        const answer = await transport.send({ request, headers: requestHeaders, signal });
        responseHeaders = new Headers({ "content-type": answer.contentType });
        responseText = answer.body.slice(0, ANSWER_LIMIT);
        outcome = {
          status: "acknowledged",
          responseStatus: 200,
          responseBody: responseText.slice(0, RESPONSE_BODY_LIMIT),
        };
      } else {
        const response = await fetch(request.url, {
          method: "POST",
          headers: requestHeaders,
          body,
          redirect: "manual",
          signal,
        });
        responseHeaders = response.headers;
        // The attempt keeps the start of the answer; whoever acts on the answer gets more of it, still bounded.
        responseText = (await response.text()).slice(0, ANSWER_LIMIT);
        const responseBody = responseText.slice(0, RESPONSE_BODY_LIMIT);
        outcome = { status: response.ok ? "acknowledged" : "failed", responseStatus: response.status, responseBody };
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      outcome = { status: name === "TimeoutError" || name === "AbortError" ? "timed_out" : "unreachable" };
    }
    const attempt: DeliveryAttempt = { ...started, ...outcome, durationMs: this.#clock() - sentAt };
    if (cancelled.aborted) return { attempt, responseHeaders };
    const answer = responseText === undefined ? {} : { responseText };
    record.attempts[index] = attempt;
    this.#events.append(request.session, request.driver, "delivery_attempt", { id: request.id, ...attempt });
    this.#log.debug("delivery attempt", { id: request.id, driver: request.driver, type: request.type, ...outcome });
    return { attempt, responseHeaders, ...answer };
  }
}
