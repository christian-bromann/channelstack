import type { Clock } from "../clock/index.ts";

/** Is the agent idle, and for how long? Negative and exact-count matchers wait for this before they check. */
export interface QuietState {
  /** Something is still happening: a call from the agent in flight, a delivery not settled, a stream open. */
  busy: boolean;
  /** Milliseconds since the last thing happened in the session. 0 while busy. */
  quietForMs: number;
}

/**
 * Knows when the agent has gone quiet. Three things count as work in progress: a provider API
 * call in flight, a delivery whose attempt hasn't settled, and whatever a driver says is still
 * open (a stream). When none is, the session has been quiet since its last recorded event.
 */
export class QuietDetector {
  readonly #clock: Clock;
  readonly #lastActivity = new Map<string, number>();
  /** Per session: what is expected (a retry of an operation) and until when. */
  readonly #expecting = new Map<string, Map<string, number>>();
  #callsInFlight = 0;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Wrap a provider API call from the agent. Calls aren't tied to a session until they finish, so one in flight keeps every session busy. */
  async during<T>(call: () => T | Promise<T>): Promise<T> {
    this.#callsInFlight += 1;
    try {
      return await call();
    } finally {
      this.#callsInFlight -= 1;
    }
  }

  /** Something happened in a session: an action, a delivery, an API call. */
  touch(session: string): void {
    this.#lastActivity.set(session, this.#clock());
  }

  /**
   * More is known to be coming: the agent was told to retry something after a while (a rate
   * limit). The session stays busy until it arrives or the time is up, so a check doesn't
   * conclude in the middle of the agent's backoff.
   */
  expectMore(session: string, what: string, withinMs: number): void {
    const expected = this.#expecting.get(session) ?? new Map<string, number>();
    expected.set(what, Math.max(expected.get(what) ?? 0, this.#clock() + withinMs));
    this.#expecting.set(session, expected);
  }

  /** What was expected has arrived: the agent retried. */
  arrived(session: string, what: string): void {
    this.#expecting.get(session)?.delete(what);
  }

  forget(session: string): void {
    this.#lastActivity.delete(session);
    this.#expecting.delete(session);
  }

  state(session: string, openWork: number): QuietState {
    const now = this.#clock();
    const expectingUntil = Math.max(0, ...(this.#expecting.get(session)?.values() ?? []));
    const busy = this.#callsInFlight > 0 || openWork > 0 || expectingUntil > now;
    const last = this.#lastActivity.get(session);
    if (busy) return { busy, quietForMs: 0 };
    if (last === undefined) return { busy, quietForMs: Number.MAX_SAFE_INTEGER };
    // Quiet is counted from the last event, or from the end of a window in which more was expected.
    return { busy, quietForMs: now - Math.max(last, expectingUntil) };
  }
}
