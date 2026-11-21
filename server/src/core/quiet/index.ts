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

  forget(session: string): void {
    this.#lastActivity.delete(session);
  }

  state(session: string, openWork: number): QuietState {
    const busy = this.#callsInFlight > 0 || openWork > 0;
    const last = this.#lastActivity.get(session);
    return { busy, quietForMs: busy ? 0 : last === undefined ? Number.MAX_SAFE_INTEGER : this.#clock() - last };
  }
}
