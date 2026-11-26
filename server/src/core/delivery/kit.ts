import type { Clock } from "../clock/index.ts";
import { randomToken } from "../secrets/index.ts";
import type {
  AttemptOptions,
  DeliveryAttempt,
  DeliveryQueue,
  DeliveryRecord,
  DeliveryRequest,
  RetryPolicy,
} from "./index.ts";

/**
 * A platform that retries on a fixed schedule: the n-th retry `delaysMs[n]` after the attempt
 * before it. `headers` adds the platform's retry headers to each retry, and ends the chain by
 * returning undefined (an agent that said not to retry). Without it, retries carry no extra headers.
 */
export function fixedRetries(
  delaysMs: readonly number[],
  headers?: (
    attempt: DeliveryAttempt,
    retries: number,
    responseHeaders: Headers | undefined,
  ) => Record<string, string> | undefined,
): RetryPolicy {
  return {
    next(attempt, retries, responseHeaders) {
      const afterMs = delaysMs[retries];
      if (afterMs === undefined) return undefined;
      const extra = headers ? headers(attempt, retries, responseHeaders) : {};
      return extra === undefined ? undefined : { afterMs, headers: extra };
    },
  };
}

/** How one platform sends its events: everything about its deliveries a driver would otherwise write itself. */
export interface PlatformDeliveries {
  /** The driver whose deliveries these are. */
  readonly driver: string;
  /** How long the platform waits for the agent's answer before it counts the attempt as failed. */
  readonly timeoutMs: number;
  /** How the platform retries a delivery the agent didn't acknowledge. Without it, there is one attempt. */
  readonly retry?: RetryPolicy;
  /** How the platform puts each attempt into the signed body (`DeliveryRequest.stamp`). */
  readonly stamp?: DeliveryRequest["stamp"];
  /** The platform's headers for one attempt, signed with `secret` over the exact body, at `atMs`. */
  sign(secret: string, body: string, atMs: number, request: { id: string; type: string }): Record<string, string>;
  /** The secret the agent checks signatures with. */
  secret(): string;
  /** A secret the agent can't know, for a forged delivery. Defaults to a random token. */
  forgedSecret?(): string;
  /** How far back a stale delivery is signed: past what the platform's own receivers accept. */
  readonly staleMs?: number;
}

/** One delivery to send. What the platform always sends the same way comes from `PlatformDeliveries`. */
type Outgoing = Omit<DeliveryRequest, "driver" | "sign" | "timeoutMs" | "retry" | "stamp"> & {
  /** Sign this one differently: a request the platform doesn't sign (Notion's verification). */
  readonly sign?: DeliveryRequest["sign"];
  /** `false`: the platform doesn't retry this one (Slack's interactions). */
  readonly retry?: RetryPolicy | false;
  /** `false`: this one carries no attempt stamp. */
  readonly stamp?: DeliveryRequest["stamp"] | false;
};

/** How a test sends a delivery again: forged, stale, or with extra headers. */
interface ForgeOptions {
  readonly badSignature?: boolean;
  readonly stale?: boolean;
  /**
   * A forgery only the platform knows how to make, signed in its place: a Pub/Sub token for
   * another audience. It is handed the secret and time the other options chose (another key for
   * `badSignature`, a past time for `stale`), so they combine. The attempt counts as forged.
   */
  readonly forge?: (secret: string, body: string, atMs: number) => Record<string, string>;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** A platform's deliveries, on the one delivery queue. */
export interface DeliveryKit {
  /** Hand a delivery to the queue, signed with the platform's secret. */
  send(outgoing: Outgoing): DeliveryRecord;
  /** Send it again as a test forges it: signed with a secret the agent doesn't know, or stale. */
  resend(session: string, id: string, options?: ForgeOptions): Promise<DeliveryAttempt>;
  /** Send it again as the platform does: the same delivery, signed again (with a platform's retry headers). */
  redeliver(session: string, id: string, options?: AttemptOptions): Promise<DeliveryAttempt>;
  /** This platform's deliveries in a session, oldest first. */
  deliveries(session: string): DeliveryRecord[];
  delivery(session: string, id: string): DeliveryRecord;
}

/**
 * A platform's deliveries, written once for every driver: it signs, stamps and retries the way
 * `platform` says, and hands everything to the queue, which is the only thing that calls the agent.
 */
export function deliveryKit(
  deps: { delivery: DeliveryQueue; clock: Clock },
  platform: PlatformDeliveries,
): DeliveryKit {
  const { delivery, clock } = deps;
  const signer =
    (secret: string, request: { id: string; type: string }) =>
    (body: string, atMs: number): Record<string, string> =>
      platform.sign(secret, body, atMs, request);
  return {
    send(outgoing) {
      const { retry, stamp, sign, ...rest } = outgoing;
      const retryPolicy = retry === false ? undefined : (retry ?? platform.retry);
      const stamper = stamp === false ? undefined : (stamp ?? platform.stamp);
      return delivery.enqueue({
        ...rest,
        driver: platform.driver,
        timeoutMs: platform.timeoutMs,
        sign: sign ?? signer(platform.secret(), outgoing),
        ...(retryPolicy ? { retry: retryPolicy } : {}),
        ...(stamper ? { stamp: stamper } : {}),
      });
    },
    resend(session, id, options = {}) {
      const { request } = delivery.get(session, id);
      const secret = options.badSignature ? (platform.forgedSecret?.() ?? randomToken()) : platform.secret();
      const stale = options.stale === true;
      return delivery.again(session, id, {
        sign: options.forge ? (body, atMs) => options.forge?.(secret, body, atMs) ?? {} : signer(secret, request),
        forged: options.badSignature === true || stale || options.forge !== undefined,
        ...(stale ? { atMs: clock() - (platform.staleMs ?? 0) } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
      });
    },
    redeliver: (session, id, options = {}) => delivery.again(session, id, options),
    deliveries: (session) => delivery.list(session).filter(({ request }) => request.driver === platform.driver),
    delivery: (session, id) => delivery.get(session, id),
  };
}
