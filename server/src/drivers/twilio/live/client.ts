import { RATE_LIMIT_RETRIES, systemTimers, type Timers, waitRetryAfter } from "../../../core/clock/index.ts";
import { LivePlatformRefusal } from "../../../core/errors/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";

/** Twilio's REST API. */
export const TWILIO_API = "https://api.twilio.com";

/**
 * One way into a Twilio account: who signs in (the Account SID, or an API key's SID) and the secret
 * (its Auth Token, or the key's secret), and the account it opens.
 */
export interface TwilioAuth {
  readonly username: string;
  readonly accountSid: string;
  readonly secret: LiveCredential;
}

/** Twilio refusing a call, with its error code as the refusal's (`21211`, `20003`). */
export class TwilioRefusal extends LivePlatformRefusal {}

/**
 * Calls Twilio's REST API (2010-04-01) with one account's credentials per call, form-encoded as
 * Twilio takes them. A refusal is a `TwilioRefusal` with Twilio's error code and message; a rate
 * limit (429, 20429) is waited out, as `Retry-After` says. The secret goes into the header only.
 */
export class TwilioRestClient {
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #timers: Timers;

  constructor(options: { base?: string | undefined; fetch?: typeof fetch; timers?: Timers } = {}) {
    this.#base = options.base ?? TWILIO_API;
    this.#fetch = options.fetch ?? fetch;
    this.#timers = options.timers ?? systemTimers;
  }

  /** `path` is under the account: `/Messages.json`; `""` is the account itself. */
  async call<T>(
    auth: TwilioAuth,
    method: "GET" | "POST" | "DELETE",
    path: string,
    form?: Readonly<Record<string, string | readonly string[] | undefined>>,
  ): Promise<T> {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(form ?? {})) {
      for (const each of typeof value === "string" ? [value] : (value ?? [])) body.append(name, each);
    }
    const url = `${this.#base}/2010-04-01/Accounts/${auth.accountSid}${path === "" ? ".json" : path}`;
    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetch(url, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${auth.username}:${auth.secret.reveal()}`).toString("base64")}`,
          accept: "application/json",
          ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(method === "POST" ? { body: body.toString() } : {}),
      });
      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await waitRetryAfter(this.#timers, response.headers);
        continue;
      }
      if (response.status === 204) return undefined as T;
      const answer = (await response.json().catch(() => undefined)) as
        (T & { code?: unknown; message?: unknown }) | undefined;
      if (!response.ok) {
        const code = typeof answer?.code === "number" ? String(answer.code) : `http_${response.status}`;
        const said = typeof answer?.message === "string" ? answer.message : `HTTP ${response.status}`;
        // The path without its query, which names numbers (`?To=`), and without the account.
        const where = path.split("?")[0] || "the account";
        throw new TwilioRefusal(code, `Twilio refused ${method} ${where}: ${said}`, {
          path: where,
          status: response.status,
        });
      }
      return answer as T;
    }
  }
}
