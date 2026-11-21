/** Milliseconds since the epoch. Injected wherever time ends up in an id, a signature or a log entry. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

/**
 * Doing something later. Injected like the clock, so a test moves time forward itself
 * instead of waiting for it: a platform's retry a minute on, a fault's latency.
 */
export interface Timers {
  /** Run `task` after `delayMs`. Returns the way to call it off. */
  after(delayMs: number, task: () => void): () => void;
}

export const systemTimers: Timers = {
  after(delayMs, task) {
    const timer = setTimeout(task, delayMs);
    return () => clearTimeout(timer);
  },
};

/** Resolves after `delayMs` on these timers. */
export const delay = (timers: Timers, delayMs: number): Promise<void> =>
  delayMs <= 0 ? Promise.resolve() : new Promise((resolve) => timers.after(delayMs, resolve));
