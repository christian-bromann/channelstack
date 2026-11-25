import notionClient from "@notionhq/client";

import { LivePlatformRefusal } from "../../../core/errors/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";

// The package is CommonJS: Node gives it to an ES module as its default export.
const { APIResponseError, Client, isNotionClientError } = notionClient;

/** Real Notion's REST API. Only `createApp` can point the client elsewhere (a stub in unit tests), never the environment. */
export const NOTION_API = "https://api.notion.com";
/** The version the fake answers as (data sources split from databases). */
const NOTION_VERSION = "2025-09-03";

/** Notion refusing a call, with its own code (`object_not_found`, `validation_error`, `restricted_resource`, …). */
export class NotionRefusal extends LivePlatformRefusal {}

type Method = "get" | "post" | "patch" | "delete";

/** Codes of a refusal that will pass: a rate limit, or Notion's own failure. Asked again later, it may well be answered. */
const PASSING = new Set([
  "rate_limited",
  "internal_server_error",
  "service_unavailable",
  "database_connection_unavailable",
  "gateway_timeout",
  "unexpected",
]);

export const passing = (error: unknown): boolean => error instanceof NotionRefusal && PASSING.has(error.code);

/**
 * Calls Notion's REST API through Notion's own client, with one credential per call: the
 * integration's token, or a person's personal access token. A refusal is a `NotionRefusal` with
 * Notion's code and message, never the token. The client retries a rate limit (`Retry-After`) itself.
 */
export class NotionRestClient {
  readonly #client: InstanceType<typeof Client>;

  constructor(options: { base: string | undefined; fetch: typeof fetch }) {
    this.#client = new Client({
      baseUrl: options.base ?? NOTION_API,
      fetch: options.fetch,
      notionVersion: NOTION_VERSION,
      // The client logs requests and warnings: nothing of it belongs in channelstack's output.
      logger: () => {},
      retry: { maxRetries: 3 },
    });
  }

  async call<T = Record<string, unknown>>(
    credential: LiveCredential,
    method: Method,
    path: string,
    input: { query?: Record<string, string | number | undefined>; body?: Record<string, unknown> } = {},
  ): Promise<T> {
    const query = Object.fromEntries(
      Object.entries(input.query ?? {}).filter((entry): entry is [string, string | number] => entry[1] !== undefined),
    );
    try {
      return (await this.#client.request({
        path,
        method,
        auth: credential.reveal(),
        ...(Object.keys(query).length > 0 ? { query } : {}),
        ...(input.body ? { body: input.body } : {}),
      })) as T;
    } catch (error) {
      const operation = `${method.toUpperCase()} /${path.replace(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/g, "{id}")}`;
      if (error instanceof APIResponseError) {
        throw new NotionRefusal(error.code, `Notion refused ${operation}: ${error.message}`, { operation });
      }
      if (isNotionClientError(error)) {
        throw new NotionRefusal("unexpected", `Notion refused ${operation}: ${error.code}`, { operation });
      }
      throw error;
    }
  }

  /** Every result of a paginated list (`results`, `has_more`, `next_cursor`), page by page. */
  async all<T>(
    credential: LiveCredential,
    method: Method,
    path: string,
    input: { query?: Record<string, string | number | undefined>; body?: Record<string, unknown> } = {},
  ): Promise<T[]> {
    const found: T[] = [];
    let cursor: string | undefined;
    do {
      const page: { results: T[]; has_more: boolean; next_cursor: string | null } = await this.call(
        credential,
        method,
        path,
        method === "get"
          ? { query: { ...input.query, page_size: 100, start_cursor: cursor } }
          : { body: { ...input.body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } },
      );
      found.push(...page.results);
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return found;
  }
}
