import { RATE_LIMIT_RETRIES, systemTimers, type Timers, waitRetryAfter } from "../../../core/clock/index.ts";
import { LivePlatformRefusal } from "../../../core/errors/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import { DISCORD_ERRORS, type DiscordErrorCode, DiscordRefusal } from "../world.ts";

/** Discord's REST API, the version the fake answers too. */
const DISCORD_API = "https://discord.com/api/v10";

/** A refusal of Discord's that the fake never answers with: by its JSON code. */
class DiscordLiveRefusal extends LivePlatformRefusal {}

/**
 * Calls Discord's REST API as the agent's bot, with its token. A refusal is a `DiscordRefusal`
 * by Discord's JSON error code; a rate limit is waited out, as `Retry-After` says. The token goes
 * into the header only, never into a message.
 */
export class DiscordRestClient {
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #timers: Timers;

  constructor(options: { base?: string | undefined; fetch?: typeof fetch; timers?: Timers } = {}) {
    this.#base = options.base ?? DISCORD_API;
    this.#fetch = options.fetch ?? fetch;
    this.#timers = options.timers ?? systemTimers;
  }

  async call<T>(credential: LiveCredential, method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: {
          authorization: `Bot ${credential.reveal()}`,
          // Discord asks every bot to say what it is, in this form.
          "user-agent": "DiscordBot (https://github.com/christian-bromann/channelstack, 1)",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await waitRetryAfter(this.#timers, response.headers);
        continue;
      }
      const text = await response.text();
      // A page in front of the API (Cloudflare's 1015, a 502) answers HTML: a refusal by its status.
      let parsed: unknown;
      try {
        parsed = text === "" ? undefined : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (response.ok) return parsed as T;
      const refused = (parsed ?? {}) as { code?: unknown; message?: unknown };
      const code = typeof refused.code === "number" ? refused.code : 0;
      const message = typeof refused.message === "string" ? refused.message : `Discord answered ${response.status}`;
      if (code in DISCORD_ERRORS) throw new DiscordRefusal(code as DiscordErrorCode, { message });
      throw new DiscordLiveRefusal(
        code === 0 ? `http_${response.status}` : String(code),
        message,
        { path },
        response.status,
      );
    }
  }
}
