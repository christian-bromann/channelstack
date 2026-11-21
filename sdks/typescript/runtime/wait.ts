import { type Duration, parseDuration } from "./duration.ts";

export interface WaitOptions {
  /** Give up after this long. Default: 10s. */
  timeout?: Duration;
  /** How often to read. Default: 50ms. */
  interval?: Duration;
}

export class WaitTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    this.name = "WaitTimeoutError";
  }
}

/**
 * The one polling loop: read until `read` returns something other than undefined, or the
 * timeout passes. Every `waitFor…`, `latest…` and matcher is built on it; tests never sleep.
 */
export async function waitFor<T>(
  what: string,
  read: () => Promise<T | undefined>,
  options: WaitOptions = {},
): Promise<T> {
  const timeout = parseDuration(options.timeout ?? "10s");
  const interval = parseDuration(options.interval ?? "50ms");
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() + interval > deadline) throw new WaitTimeoutError(what, timeout);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
