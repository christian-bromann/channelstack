/**
 * A session's rate limit (exit check 13.8) and the error it refuses a call with: OpenAI's message,
 * `type` and headers, from the numbers of the limit that refused it.
 */
import { describe, expect, test } from "vitest";

import { scriptedError } from "./errors.ts";
import { goDuration, SessionRateLimit } from "./rate-limit.ts";

const ORGANIZATION = "org-0123456789abcdefghijABCD";

/** A clock the test moves. */
function clock() {
  let now = 1_700_000_000_000;
  const read = () => now;
  return Object.assign(read, { advance: (ms: number) => (now += ms) });
}

describe("goDuration", () => {
  test("writes durations as OpenAI's headers and messages do", () => {
    expect([0, 120, 999, 1000, 1200, 9997, 60_000, 360_000, 61_500].map(goDuration)).toEqual([
      "0ms",
      "120ms",
      "999ms",
      "1s",
      "1.2s",
      "9.997s",
      "1m0s",
      "6m0s",
      "1m1.5s",
    ]);
  });
});

describe("a session's rate limit", () => {
  test("counts requests, refuses the one over the limit with its numbers, and frees up on the clock", () => {
    const now = clock();
    const limiter = new SessionRateLimit(now, { requests: { limit: 2, perMs: 10_000 }, error: "rate_limit" });

    expect(limiter.refusal(5)).toBeUndefined();
    now.advance(1_000);
    expect(limiter.refusal(5)).toBeUndefined();
    now.advance(1_500);
    const refused = limiter.refusal(5);
    now.advance(7_500);

    expect(refused).toEqual({ limit: "requests", of: 2, used: 2, requested: 1, perMs: 10_000, waitMs: 7_500 });
    expect(limiter.refusal(5)).toBeUndefined();
  });

  test("counts tokens, and refuses a call whose tokens don't fit, naming how many it asked for", () => {
    const now = clock();
    const limiter = new SessionRateLimit(now, { tokens: { limit: 100, perMs: 60_000 }, error: "rate_limit" });

    expect(limiter.refusal(70)).toBeUndefined();
    now.advance(20_000);
    const refused = limiter.refusal(40);

    expect(refused).toEqual({ limit: "tokens", of: 100, used: 70, requested: 40, perMs: 60_000, waitMs: 40_000 });
    expect(limiter.headers()).toMatchObject({
      "x-ratelimit-limit-tokens": "100",
      "x-ratelimit-remaining-tokens": "30",
      "x-ratelimit-reset-tokens": "40s",
    });
    // A refused call isn't counted: one that fits still goes through.
    expect(limiter.refusal(30)).toBeUndefined();
  });
});

describe("the rate_limit error", () => {
  test("a limiter's refusal: OpenAI's message with the limit's numbers, its type, and when to retry", () => {
    const now = clock();
    const limiter = new SessionRateLimit(now, { tokens: { limit: 1_000, perMs: 60_000 }, error: "rate_limit" });
    limiter.refusal(900);
    now.advance(57_886);
    const limit = limiter.refusal(213);

    const error = scriptedError("rate_limit", {
      model: "gpt-5",
      endpoint: "chat.completions",
      organization: ORGANIZATION,
      limit,
    });

    expect(error.status).toBe(429);
    expect(error.body()).toEqual({
      error: {
        message: `Rate limit reached for gpt-5 in organization ${ORGANIZATION} on tokens per min (TPM): Limit 1000, Used 900, Requested 213. Please try again in 2.114s. Visit https://platform.openai.com/account/rate-limits to learn more.`,
        type: "tokens",
        param: null,
        code: "rate_limit_exceeded",
      },
    });
    // The limiter's own headers tell the truth about what is left; the error only says when to retry.
    expect(error.headers).toEqual({ "retry-after": "3", "retry-after-ms": "2114" });
  });

  test("a limit per day is named per day", () => {
    const now = clock();
    const limiter = new SessionRateLimit(now, { requests: { limit: 1, perMs: 86_400_000 }, error: "rate_limit" });
    limiter.refusal(1);

    const error = scriptedError("rate_limit", { model: "gpt-5", endpoint: "responses", limit: limiter.refusal(1) });

    expect(error.message).toMatch(/ on requests per day \(RPD\): Limit 1, Used 1, Requested 1\. /);
  });

  test("a scripted one: the tier's requests used up until retryAfter, in its message and headers", () => {
    const error = scriptedError("rate_limit", {
      model: "gpt-5",
      endpoint: "responses",
      organization: ORGANIZATION,
      retryAfterMs: 2_000,
    });

    expect(error.type).toBe("requests");
    expect(error.message).toBe(
      `Rate limit reached for gpt-5 in organization ${ORGANIZATION} on requests per min (RPM): Limit 10000, Used 10000, Requested 1. Please try again in 2s. Visit https://platform.openai.com/account/rate-limits to learn more.`,
    );
    expect(error.headers).toEqual({
      "retry-after": "2",
      "retry-after-ms": "2000",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-reset-requests": "2s",
    });
  });

  test("retry-after is left out when there is nothing to wait: OpenAI's description makes it at least 1", () => {
    expect(scriptedError("overloaded", { model: "gpt-5", endpoint: "responses" }).headers).toEqual({
      "retry-after-ms": "0",
    });
    expect(scriptedError("server_error", { model: "gpt-5", endpoint: "responses", retryAfterMs: 120 }).headers).toEqual(
      { "retry-after": "1", "retry-after-ms": "120" },
    );
  });
});
