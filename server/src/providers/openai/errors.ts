import { goDuration, type RateLimitRefusal, scriptedRefusal } from "./rate-limit.ts";
import type { Endpoint, ErrorKind } from "./turns.ts";

/** An error as OpenAI answers it: `{ error: { message, type, param, code } }`, with its status and headers. */
export class OpenAIError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | null;
  readonly param: string | null;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: number,
    error: { message: string; type: string; code?: string | null; param?: string | null },
    headers: Readonly<Record<string, string>> = {},
  ) {
    super(error.message);
    this.name = "OpenAIError";
    this.status = status;
    this.type = error.type;
    this.code = error.code ?? null;
    this.param = error.param ?? null;
    this.headers = headers;
  }

  body(): { error: { message: string; type: string; param: string | null; code: string | null } } {
    return { error: { message: this.message, type: this.type, param: this.param, code: this.code } };
  }
}

/** A request OpenAI refuses as invalid: 400 `invalid_request_error`. */
export const invalidRequest = (message: string, param: string | null = null, code: string | null = null) =>
  new OpenAIError(400, { message, type: "invalid_request_error", param, code });

/** What isn't served by the fake: channelstack's own code in OpenAI's error body. */
export const unsupportedInFake = (what: string, param: string | null = null) =>
  invalidRequest(
    `channelstack: ${what} isn't supported by the fake OpenAI (docs/decisions/0029-fake-openai.md).`,
    param,
    "unsupported_in_fake",
  );

/** A path OpenAI doesn't have. */
export const notFound = (method: string, path: string) =>
  new OpenAIError(404, {
    message: `Invalid URL (${method} ${path})`,
    type: "invalid_request_error",
  });

/**
 * Every error kind a script can answer with: its status, `type`, `code` and message, as OpenAI's
 * guide documents them. `rate_limit` is built from the limit that refused the call (`rateLimitMessage`).
 */
const KINDS: Readonly<
  Record<
    Exclude<ErrorKind, "timeout" | "rate_limit">,
    { status: number; type: string; code: string | null; message: (model: string) => string; param?: string }
  >
> = {
  slow_down: {
    status: 429,
    type: "rate_limit_error",
    code: "slow_down",
    message: () =>
      "Your request rate increased too quickly. Please reduce the request rate and gradually increase it again.",
  },
  insufficient_quota: {
    status: 429,
    type: "insufficient_quota",
    code: "insufficient_quota",
    message: () =>
      "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
  },
  credit_balance_exhausted: {
    status: 429,
    type: "insufficient_quota",
    code: "credit_balance_exhausted",
    message: () => "Credit balance exhausted. Add credits to continue using the API.",
  },
  organization_spend_limit_exceeded: {
    status: 429,
    type: "insufficient_quota",
    code: "organization_spend_limit_exceeded",
    message: () => "Organization spend limit reached. Raise or remove the limit to continue.",
  },
  project_spend_limit_exceeded: {
    status: 429,
    type: "insufficient_quota",
    code: "project_spend_limit_exceeded",
    message: () => "Project spend limit reached. Raise or remove the limit to continue.",
  },
  organization_usage_limit_exceeded: {
    status: 429,
    type: "insufficient_quota",
    code: "organization_usage_limit_exceeded",
    message: () => "Organization usage limit reached. Contact support to raise it.",
  },
  server_error: {
    status: 500,
    type: "server_error",
    code: null,
    message: () =>
      "The server had an error while processing your request. Sorry about that! You can retry your request, or contact us through our help center if the error persists.",
  },
  overloaded: {
    status: 503,
    type: "service_unavailable_error",
    code: "server_is_overloaded",
    message: () => "The model is temporarily overloaded. Please retry your request after a brief delay.",
  },
  context_length_exceeded: {
    status: 400,
    type: "invalid_request_error",
    code: "context_length_exceeded",
    message: () =>
      "This model's maximum context length is 128000 tokens. However, your messages resulted in more tokens. Please reduce the length of the messages.",
    param: "messages",
  },
  content_policy: {
    status: 400,
    type: "invalid_request_error",
    code: "invalid_prompt",
    message: () => "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
  },
  invalid_api_key: {
    status: 401,
    type: "invalid_request_error",
    code: "invalid_api_key",
    message: () =>
      "Incorrect API key provided. You can find your API key at https://platform.openai.com/account/api-keys.",
  },
  not_in_organization: {
    status: 401,
    type: "invalid_request_error",
    code: "no_organization",
    message: () => "You must be a member of an organization to use the API. Please contact us through our help center.",
  },
  ip_not_authorized: {
    status: 401,
    type: "invalid_request_error",
    code: "ip_not_authorized",
    message: () => "IP not authorized. Your IP is not allowed to access this organization or project.",
  },
  unsupported_region: {
    status: 403,
    type: "request_forbidden",
    code: "unsupported_country_region_territory",
    message: () => "Country, region, or territory not supported",
  },
};

/** The limit a rate limit's message names, by what it counts and its window: OpenAI's per minute or per day. */
function limitName(refusal: RateLimitRefusal): string {
  const day = refusal.perMs >= 86_400_000;
  if (refusal.limit === "tokens") return day ? "tokens per day (TPD)" : "tokens per min (TPM)";
  return day ? "requests per day (RPD)" : "requests per min (RPM)";
}

/** A rate limit's message as the live API writes it, with the numbers of the limit that refused the call. */
function rateLimitMessage(model: string, organization: string | undefined, refusal: RateLimitRefusal): string {
  const where = organization === undefined ? "" : ` in organization ${organization}`;
  return `Rate limit reached for ${model}${where} on ${limitName(refusal)}: Limit ${refusal.of}, Used ${refusal.used}, Requested ${refusal.requested}. Please try again in ${goDuration(refusal.waitMs)}. Visit https://platform.openai.com/account/rate-limits to learn more.`;
}

/**
 * A scripted error, as OpenAI answers it. `timeout` isn't one: it is no answer at all. A
 * `rate_limit` names the limit that refused the call (`limit`, from a session's rate limit); a
 * scripted one names the default tier's request limit, used up until `retryAfterMs` has passed,
 * and its headers say so.
 */
export function scriptedError(
  kind: Exclude<ErrorKind, "timeout">,
  options: {
    model: string;
    message?: string | undefined;
    retryAfterMs?: number | undefined;
    shouldRetry?: boolean | undefined;
    endpoint: Endpoint;
    limit?: RateLimitRefusal | undefined;
    organization?: string | undefined;
  },
): OpenAIError {
  const status = kind === "rate_limit" ? 429 : KINDS[kind].status;
  const headers: Record<string, string> = {};
  const retryAfterMs =
    options.retryAfterMs ?? options.limit?.waitMs ?? (status === 429 || status >= 500 ? 0 : undefined);
  if (retryAfterMs !== undefined) {
    // OpenAI's description: `retry-after` is whole seconds, at least one, and left out when there is nothing to wait.
    if (retryAfterMs > 0) headers["retry-after"] = String(Math.ceil(retryAfterMs / 1000));
    headers["retry-after-ms"] = String(retryAfterMs);
  }
  if (options.shouldRetry !== undefined) headers["x-should-retry"] = String(options.shouldRetry);
  if (kind === "rate_limit") {
    const refusal = options.limit ?? scriptedRefusal(retryAfterMs ?? 0);
    // A session's limiter already tells the truth in its headers; a scripted refusal is the tier, used up.
    if (options.limit === undefined) {
      headers["x-ratelimit-remaining-requests"] = "0";
      headers["x-ratelimit-reset-requests"] = goDuration(refusal.waitMs);
    }
    return new OpenAIError(
      status,
      {
        message: options.message ?? rateLimitMessage(options.model, options.organization, refusal),
        // OpenAI's rate-limit errors name what the limit counts as their type.
        type: refusal.limit,
        code: "rate_limit_exceeded",
      },
      headers,
    );
  }
  const known = KINDS[kind];
  const param = known.param === "messages" && options.endpoint === "responses" ? "input" : (known.param ?? null);
  return new OpenAIError(
    status,
    { message: options.message ?? known.message(options.model), type: known.type, code: known.code, param },
    headers,
  );
}
