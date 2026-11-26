import { RATE_LIMIT_RETRIES, systemTimers, type Timers, waitRetryAfter } from "../../../core/clock/index.ts";
import { LivePlatformRefusal } from "../../../core/errors/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";

/** Gmail's API, as `googleapis` reaches it: the root its paths start under. */
export const GMAIL_API = "https://gmail.googleapis.com/";
/** Google's token endpoint. */
const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Refresh a minute before an access token runs out. */
const EARLY_MS = 60_000;

/** Google refusing a call, with its own reason (`notFound`, `invalid_grant`). */
class GoogleRefusal extends LivePlatformRefusal {}

/**
 * Calls Gmail's API as one mailbox: a refresh token from the agent's OAuth client for each, the
 * agent's own and each person's. It trades the refresh token for an access token when it needs
 * one, and keeps that token in memory only. A refusal is a `GoogleRefusal` with Google's reason; a
 * rate limit is waited out, as `Retry-After` says. Tokens go into requests only, never into a message.
 */
export class GoogleRestClient {
  readonly #base: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timers: Timers;
  readonly #client: () => { id: string; secret: LiveCredential };
  readonly #access = new WeakMap<LiveCredential, { token: string; until: number }>();

  constructor(options: {
    base?: string | undefined;
    fetch?: typeof fetch;
    timers?: Timers;
    /** The agent's OAuth client: every refresh token is from it. */
    client: () => { id: string; secret: LiveCredential };
  }) {
    this.#base = options.base?.replace(/\/$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timers = options.timers ?? systemTimers;
    this.#client = options.client;
  }

  /** Trash a thread of the mailbox, as a run's cleanup and the sweep do: Gmail empties the trash in 30 days. */
  trashThread(credential: LiveCredential, thread: string): Promise<unknown> {
    return this.call(credential, "POST", `gmail/v1/users/me/threads/${thread}/trash`);
  }

  /** Delete a label of the mailbox: Gmail takes it off every message that has it. */
  deleteLabel(credential: LiveCredential, label: string): Promise<unknown> {
    return this.call(credential, "DELETE", `gmail/v1/users/me/labels/${label}`);
  }

  /** An access token for the mailbox whose refresh token this is. */
  async #token(credential: LiveCredential): Promise<string> {
    const held = this.#access.get(credential);
    if (held && held.until > Date.now() + EARLY_MS) return held.token;
    const client = this.#client();
    const response = await this.#fetch(this.#base ? `${this.#base}/token` : TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.id,
        client_secret: client.secret.reveal(),
        refresh_token: credential.reveal(),
      }).toString(),
    });
    const answer = (await response.json().catch(() => undefined)) as
      { access_token?: string; expires_in?: number; error?: string; error_description?: string } | undefined;
    if (!response.ok || typeof answer?.access_token !== "string") {
      const reason = answer?.error ?? `http_${response.status}`;
      throw new GoogleRefusal(reason, `Google refused the refresh token: ${answer?.error_description ?? reason}`, {
        path: "/token",
      });
    }
    this.#access.set(credential, { token: answer.access_token, until: Date.now() + (answer.expires_in ?? 0) * 1000 });
    return answer.access_token;
  }

  /** One Gmail call as the mailbox, `path` under the API's root (`gmail/v1/users/me/profile`). */
  async call<T>(
    credential: LiveCredential,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetch(`${this.#base ? `${this.#base}/` : GMAIL_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await this.#token(credential)}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await waitRetryAfter(this.#timers, response.headers);
        continue;
      }
      if (response.status === 204) return undefined as T;
      const answer = (await response.json().catch(() => undefined)) as
        (T & { error?: { message?: string; errors?: Array<{ reason?: string }> } }) | undefined;
      if (!response.ok) {
        const reason = answer?.error?.errors?.[0]?.reason ?? `http_${response.status}`;
        // The path without its query: a query names addresses (`q=from:`).
        const where = path.split("?")[0];
        throw new GoogleRefusal(reason, `Gmail refused ${method} ${where}: ${answer?.error?.message ?? reason}`, {
          path: where,
        });
      }
      return answer as T;
    }
  }
}
