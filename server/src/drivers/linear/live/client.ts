import { delay, type Timers } from "../../../core/clock/index.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";

/** Real Linear's GraphQL API. Only `createApp` can point the client elsewhere (a stub in unit tests), never the environment. */
const LINEAR_API = "https://api.linear.app/graphql";

const RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 30_000;

/** Linear refusing a call, with its own error code (`extensions.code`: `INPUT_ERROR`, `FORBIDDEN`, …). */
export class LinearRefusal extends ProtocolError {
  constructor(code: string, message: string, data: Record<string, unknown> = {}) {
    super({ platform: code, status: 409 }, message, data);
  }
}

/**
 * Calls Linear's GraphQL API with one credential per call: the app's OAuth token, or a person's
 * personal API key. A refusal is a `LinearRefusal` with Linear's code and its message for people
 * (`userPresentableMessage`), never the token or the rest of the answer.
 */
export class LinearGraphqlClient {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #timers: Timers;

  constructor(options: { url: string | undefined; fetch: typeof fetch; timers: Timers }) {
    this.#url = options.url ?? LINEAR_API;
    this.#fetch = options.fetch;
    this.#timers = options.timers;
  }

  async call<T = Record<string, unknown>>(
    credential: LiveCredential,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    // A personal API key goes as it is; an OAuth token as a bearer token (Linear's docs).
    const token = credential.reveal();
    const authorization = token.startsWith("lin_api_") ? token : `Bearer ${token}`;
    const operation = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "query";
    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      const answer = (await response.json().catch(() => undefined)) as
        { data?: T; errors?: Array<{ message?: string; extensions?: Record<string, unknown> }> } | undefined;
      const error = answer?.errors?.[0];
      const code =
        typeof error?.extensions?.code === "string"
          ? error.extensions.code
          : response.status === 429
            ? "RATELIMITED"
            : response.ok
              ? undefined
              : response.status === 401
                ? "AUTHENTICATION_ERROR"
                : "unexpected";
      if (code === "RATELIMITED" && attempt < RATE_LIMIT_RETRIES) {
        const seconds = Number(response.headers.get("retry-after") ?? "1");
        await delay(this.#timers, Math.min(MAX_RETRY_AFTER_MS, (Number.isFinite(seconds) ? seconds : 1) * 1000));
        continue;
      }
      if (code !== undefined || !answer?.data) {
        const said = error?.extensions?.userPresentableMessage;
        const reason = typeof said === "string" ? said : (code ?? "unexpected");
        throw new LinearRefusal(code ?? "unexpected", `Linear refused ${operation}: ${reason}`, { operation });
      }
      return answer.data;
    }
  }
}
