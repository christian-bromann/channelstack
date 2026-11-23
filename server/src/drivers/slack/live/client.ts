import { delay, type Timers } from "../../../core/clock/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import { SlackRefusal } from "../world.ts";

/** Real Slack's Web API. Only `createApp` can point the client elsewhere (a stub in unit tests), never the environment. */
export const SLACK_API = "https://slack.com/api";

/** How often a call that Slack rate-limited is tried again, after the `Retry-After` Slack asks for. */
const RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 30_000;

type Params = Readonly<Record<string, string | number | boolean | undefined | readonly unknown[] | object>>;

/** A Web API answer: `ok`, and the method's own fields. */
export type SlackAnswer = { ok: true } & Record<string, unknown>;

/**
 * Calls Slack's Web API with one credential per call: the app's bot token, or a person's user
 * token. A refusal becomes a `SlackRefusal` with Slack's own code; the message names the method
 * and the code only, never the token or the rest of Slack's answer.
 */
export class SlackWebClient {
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #timers: Timers;

  constructor(options: { base: string | undefined; fetch: typeof fetch; timers: Timers }) {
    this.#base = (options.base ?? SLACK_API).replace(/\/$/, "");
    this.#fetch = options.fetch;
    this.#timers = options.timers;
  }

  async call(method: string, credential: LiveCredential, params: Params = {}): Promise<SlackAnswer> {
    // Form-encoded, as Slack's own SDK sends them: read methods ignore a JSON body. Blocks and
    // metadata go as JSON text in their field.
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) body.set(name, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetch(`${this.#base}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.reveal()}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        const seconds = Number(response.headers.get("retry-after") ?? "1");
        await delay(this.#timers, Math.min(MAX_RETRY_AFTER_MS, (Number.isFinite(seconds) ? seconds : 1) * 1000));
        continue;
      }
      const answer = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      if (!answer || answer.ok !== true) {
        const code =
          typeof answer?.error === "string" ? answer.error : response.status === 429 ? "ratelimited" : "unexpected";
        throw new SlackRefusal(code, `Slack refused ${method}: ${code}`, { method });
      }
      // The token's scopes come only as a header.
      const scopes = response.headers.get("x-oauth-scopes");
      return (scopes === null ? answer : { scopes, ...answer }) as SlackAnswer;
    }
  }

  /** Every page of a cursor-paginated list, joined: `conversations.history`, `conversations.replies`, `conversations.list`. */
  async all<T>(method: string, credential: LiveCredential, field: string, params: Params = {}): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    do {
      const answer = await this.call(method, credential, { limit: 200, ...params, cursor });
      items.push(...((answer[field] as T[] | undefined) ?? []));
      const next = (answer.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
      cursor = next === "" ? undefined : next;
    } while (cursor !== undefined);
    return items;
  }
}
