import { RATE_LIMIT_RETRIES, systemTimers, type Timers, waitRetryAfter } from "../../../core/clock/index.ts";
import { LivePlatformRefusal } from "../../../core/errors/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";

/** Resend's API. */
export const RESEND_API = "https://api.resend.com";

/** Resend refusing a call, with its own error name (`validation_error`, `not_found`). */
class ResendRefusal extends LivePlatformRefusal {}

/**
 * Calls Resend's REST API with one credential per call: the agent's team's key, or a person's own
 * team's. A refusal is a `ResendRefusal` with Resend's error name and message; a rate limit is
 * waited out, as `Retry-After` says. The key goes into the header only, never into a message.
 */
export class ResendRestClient {
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #timers: Timers;

  constructor(options: { base?: string | undefined; fetch?: typeof fetch; timers?: Timers } = {}) {
    this.#base = options.base ?? RESEND_API;
    this.#fetch = options.fetch ?? fetch;
    this.#timers = options.timers ?? systemTimers;
  }

  async call<T>(credential: LiveCredential, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${credential.reveal()}`,
          "content-type": "application/json",
          // Resend refuses a request without one.
          "user-agent": "channelstack",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await waitRetryAfter(this.#timers, response.headers);
        continue;
      }
      const answer = (await response.json().catch(() => undefined)) as
        (T & { name?: unknown; message?: unknown }) | undefined;
      if (!response.ok) {
        const name = typeof answer?.name === "string" ? answer.name : `http_${response.status}`;
        const said = typeof answer?.message === "string" ? answer.message : `HTTP ${response.status}`;
        // The path without its query: a query names addresses (`?to=`).
        const where = path.split("?")[0];
        throw new ResendRefusal(name, `Resend refused ${method} ${where}: ${said}`, { path: where }, response.status);
      }
      return answer as T;
    }
  }
}
