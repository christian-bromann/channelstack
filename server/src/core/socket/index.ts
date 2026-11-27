/**
 * The connections an agent holds open to a fake (Slack's Socket Mode, Discord's Gateway), and
 * waiting for one: a delivery that finds the agent between connections waits for it to come back,
 * until its attempt's signal gives up. Each fake decides what makes a connection count (a ticket
 * spent, a session identified); this only keeps them.
 */
export class OpenConnections<T> {
  readonly #open = new Set<T>();
  /** Deliveries waiting for a connection, each told when one opens. */
  #waiting: Array<() => void> = [];

  /** A connection is ready for deliveries. Whatever waited for one gets it. */
  add(connection: T): void {
    this.#open.add(connection);
    for (const retry of this.#waiting.splice(0)) retry();
  }

  /** A connection closed, or stopped counting (a session that ended). */
  delete(connection: T): boolean {
    return this.#open.delete(connection);
  }

  get size(): number {
    return this.#open.size;
  }

  /** The newest open connection: the one an agent that reconnected uses. */
  latest(): T | undefined {
    return [...this.#open].at(-1);
  }

  /** Forget every connection at once (a network drop), for the caller to close them. */
  drain(): T[] {
    const all = [...this.#open];
    this.#open.clear();
    return all;
  }

  /** Resolves with the newest open connection, waiting for one to open until `signal` aborts. */
  next(signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const ready = () => {
        const latest = this.latest();
        if (latest === undefined) return false;
        resolve(latest);
        return true;
      };
      if (ready()) return;
      const retry = () => {
        if (!ready()) this.#waiting.push(retry);
      };
      this.#waiting.push(retry);
      signal.addEventListener(
        "abort",
        () => {
          this.#waiting = this.#waiting.filter((other) => other !== retry);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }
}
