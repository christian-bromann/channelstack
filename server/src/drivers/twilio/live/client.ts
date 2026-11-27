import { RATE_LIMIT_RETRIES, systemTimers, type Timers, waitRetryAfter } from "../../../core/clock/index.ts";
import { LivePlatformRefusal } from "../../../core/errors/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import type { TwilioMessageStatus } from "../world.ts";

/** Twilio's REST API. */
export const TWILIO_API = "https://api.twilio.com";

/**
 * The account a credential opens. Every Twilio credential here is `<Account SID>:<Auth Token>`,
 * the pair basic auth sends; the SID before the colon is no secret.
 */
export const accountOf = (credential: LiveCredential): string => credential.reveal().split(":")[0] ?? "";

/** A Message resource, as the REST API answers it: what live mode reads of it. */
export interface WireMessage {
  sid: string;
  account_sid: string;
  from: string;
  to: string;
  body: string | null;
  status: TwilioMessageStatus;
  direction: string;
  error_code: number | null;
  num_segments: string | null;
  num_media: string | null;
  date_created: string;
  date_sent: string | null;
}

/** A day as Twilio's `DateSent>` filter takes it, in UTC. */
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Twilio refusing a call, with its error code as the refusal's (`21211`, `20003`). */
export class TwilioRefusal extends LivePlatformRefusal {}

/**
 * Calls Twilio's REST API (2010-04-01) with one account's credential per call, form-encoded as
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
    credential: LiveCredential,
    method: "GET" | "POST" | "DELETE",
    path: string,
    form?: Readonly<Record<string, string | readonly string[] | undefined>>,
  ): Promise<T> {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(form ?? {})) {
      for (const each of typeof value === "string" ? [value] : (value ?? [])) body.append(name, each);
    }
    const url = `${this.#base}/2010-04-01/Accounts/${accountOf(credential)}${path === "" ? ".json" : path}`;
    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetch(url, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(credential.reveal()).toString("base64")}`,
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

  /** The messages from one number to another on the account a credential opens, made since `after`. */
  async messagesBetween(credential: LiveCredential, from: string, to: string, after: number): Promise<WireMessage[]> {
    const query = new URLSearchParams({ From: from, To: to, "DateSent>": day(after), PageSize: "1000" });
    const { messages = [] } = await this.call<{ messages?: WireMessage[] }>(
      credential,
      "GET",
      `/Messages.json?${query}`,
    );
    return messages.filter((message) => (Date.parse(message.date_created) || 0) >= after);
  }
}
