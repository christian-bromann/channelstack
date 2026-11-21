import type { Clock } from "../clock/index.ts";
import type { EventLog } from "../events/index.ts";
import type { Logger } from "../log/index.ts";

export type DeliveryStatus = "acknowledged" | "failed" | "timed_out" | "unreachable";

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
  /** The platform's signature headers for this body, signed when the attempt is sent. */
  sign(body: string, atMs: number): Record<string, string>;
  /** The platform's ack window. */
  readonly timeoutMs: number;
}

const RESPONSE_BODY_LIMIT = 2048;

/**
 * Sends events to the agent and records every attempt in the event log. Drivers hand it a
 * payload and a signer; nothing else in the server calls the agent.
 */
export class DeliveryQueue {
  readonly #events: EventLog;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #inFlight = new Set<Promise<void>>();

  constructor(deps: { events: EventLog; clock: Clock; log: Logger }) {
    this.#events = deps.events;
    this.#clock = deps.clock;
    this.#log = deps.log;
  }

  enqueue(request: DeliveryRequest): void {
    const { id, session, driver, type, url } = request;
    this.#events.append(session, driver, "delivery", { id, type, url, payload: JSON.parse(request.body) });
    const attempt = this.#attempt(request, 1).finally(() => this.#inFlight.delete(attempt));
    this.#inFlight.add(attempt);
  }

  /** Resolves once no attempt is in flight. */
  async settled(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all(this.#inFlight);
  }

  async #attempt(request: DeliveryRequest, number: number): Promise<void> {
    const sentAt = this.#clock();
    const requestHeaders = {
      "content-type": "application/json",
      "user-agent": "channelstack",
      ...request.sign(request.body, sentAt),
    };
    let status: DeliveryStatus;
    let responseStatus: number | undefined;
    let responseBody: string | undefined;
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: requestHeaders,
        body: request.body,
        redirect: "manual",
        signal: AbortSignal.timeout(request.timeoutMs),
      });
      responseStatus = response.status;
      responseBody = (await response.text()).slice(0, RESPONSE_BODY_LIMIT);
      status = response.ok ? "acknowledged" : "failed";
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      status = name === "TimeoutError" || name === "AbortError" ? "timed_out" : "unreachable";
    }
    this.#events.append(request.session, request.driver, "delivery_attempt", {
      id: request.id,
      number,
      transport: "http",
      url: request.url,
      sentAt: new Date(sentAt).toISOString(),
      requestHeaders,
      status,
      ...(responseStatus === undefined ? {} : { responseStatus }),
      ...(responseBody === undefined ? {} : { responseBody }),
      durationMs: this.#clock() - sentAt,
    });
    this.#log.debug("delivery attempt", { id: request.id, driver: request.driver, type: request.type, status });
  }
}
