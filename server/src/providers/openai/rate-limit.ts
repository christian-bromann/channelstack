import type { Clock } from "../../core/clock/index.ts";

/** A limit a test set: requests and tokens per window, and what a call over it gets. */
export interface RateLimits {
  readonly requests?: { readonly limit: number; readonly perMs: number };
  readonly tokens?: { readonly limit: number; readonly perMs: number };
  readonly error: "rate_limit" | "slow_down";
}

/** Without a limit, the headers show a generous tier, so an agent that reads them sees plausible numbers. */
const DEFAULT_TIER = { requests: 10_000, tokens: 30_000_000 } as const;

/** A duration as OpenAI's reset headers write it: Go's style, `1s`, `6m0s`, `120ms`. */
export function goDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  const secondsText = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(3).replace(/0+$/, "");
  return minutes === 0 ? `${secondsText}s` : `${minutes}m${secondsText}s`;
}

interface Window {
  readonly startedAt: number;
  requests: number;
  tokens: number;
}

/** One session's limiter: fixed windows on the server's clock. */
export class SessionRateLimit {
  readonly #clock: Clock;
  readonly limits: RateLimits;
  #requests: Window;
  #tokens: Window;

  constructor(clock: Clock, limits: RateLimits) {
    this.#clock = clock;
    this.limits = limits;
    this.#requests = { startedAt: clock(), requests: 0, tokens: 0 };
    this.#tokens = { startedAt: clock(), requests: 0, tokens: 0 };
  }

  #roll(): void {
    const now = this.#clock();
    const { requests, tokens } = this.limits;
    if (requests && now - this.#requests.startedAt >= requests.perMs) this.#requests = { startedAt: now, requests: 0, tokens: 0 };
    if (tokens && now - this.#tokens.startedAt >= tokens.perMs) this.#tokens = { startedAt: now, requests: 0, tokens: 0 };
  }

  /** How long until a slot frees up, when this call is over the limit; undefined when it may go on. */
  admit(tokens: number): number | undefined {
    this.#roll();
    const now = this.#clock();
    const { requests: requestLimit, tokens: tokenLimit } = this.limits;
    if (requestLimit && this.#requests.requests >= requestLimit.limit) {
      return requestLimit.perMs - (now - this.#requests.startedAt);
    }
    if (tokenLimit && this.#tokens.tokens + tokens > tokenLimit.limit) {
      return tokenLimit.perMs - (now - this.#tokens.startedAt);
    }
    this.#requests.requests += 1;
    this.#tokens.tokens += tokens;
    return undefined;
  }

  /** What the six `x-ratelimit-*` headers say now. */
  headers(): Record<string, string> {
    this.#roll();
    const now = this.#clock();
    const { requests, tokens } = this.limits;
    return {
      "x-ratelimit-limit-requests": String(requests?.limit ?? DEFAULT_TIER.requests),
      "x-ratelimit-limit-tokens": String(tokens?.limit ?? DEFAULT_TIER.tokens),
      "x-ratelimit-remaining-requests": String(
        requests ? Math.max(0, requests.limit - this.#requests.requests) : DEFAULT_TIER.requests - 1,
      ),
      "x-ratelimit-remaining-tokens": String(
        tokens ? Math.max(0, tokens.limit - this.#tokens.tokens) : DEFAULT_TIER.tokens - 1,
      ),
      "x-ratelimit-reset-requests": goDuration(requests ? requests.perMs - (now - this.#requests.startedAt) : 6),
      "x-ratelimit-reset-tokens": goDuration(tokens ? tokens.perMs - (now - this.#tokens.startedAt) : 0),
    };
  }

  remaining(): { requests?: number; tokens?: number; resetsInMs: number } {
    const headers = this.headers();
    const now = this.#clock();
    const { requests, tokens } = this.limits;
    const resets = [
      requests ? requests.perMs - (now - this.#requests.startedAt) : undefined,
      tokens ? tokens.perMs - (now - this.#tokens.startedAt) : undefined,
    ].filter((value): value is number => value !== undefined);
    return {
      ...(requests ? { requests: Number(headers["x-ratelimit-remaining-requests"]) } : {}),
      ...(tokens ? { tokens: Number(headers["x-ratelimit-remaining-tokens"]) } : {}),
      resetsInMs: resets.length === 0 ? 0 : Math.min(...resets),
    };
  }
}

/** The headers of a call no session's limit covers. */
export function defaultRateHeaders(): Record<string, string> {
  return {
    "x-ratelimit-limit-requests": String(DEFAULT_TIER.requests),
    "x-ratelimit-limit-tokens": String(DEFAULT_TIER.tokens),
    "x-ratelimit-remaining-requests": String(DEFAULT_TIER.requests - 1),
    "x-ratelimit-remaining-tokens": String(DEFAULT_TIER.tokens - 1),
    "x-ratelimit-reset-requests": "6ms",
    "x-ratelimit-reset-tokens": "0s",
  };
}
