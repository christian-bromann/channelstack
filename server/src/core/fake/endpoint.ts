import { type Context, Hono } from "hono";

import type { DriverContext } from "../router/driver.ts";
import { recordCall } from "../router/inspect.ts";
import type { Awaitable } from "../router/inspection.ts";

/** What one endpoint answers: its body, the test sessions whose objects it read or changed, and its status. */
export interface RestAnswer {
  readonly body: unknown;
  readonly sessions: Iterable<string | undefined>;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

/** How one platform's REST API answers around its endpoints: who may call, and its error shape. */
export interface RestPlatform {
  /** The driver whose calls these are. */
  readonly driver: string;
  /** Who may call this endpoint: undefined to go on, or the platform's refusal (no key, a wrong one). */
  authorize(c: Context, operation: string): RestAnswer | undefined;
  /** A refusal the handlers throw, as the platform answers it; undefined for anything else, which is a bug. */
  refusal(error: unknown): RestAnswer | undefined;
  /** A body that isn't JSON. */
  invalidJson(): RestAnswer;
  /** A path the API doesn't have. */
  notFound(c: Context): RestAnswer;
  /** What the platform adds to every answer (a request id). */
  decorate?(answer: RestAnswer): RestAnswer;
}

type Method = "get" | "post" | "put" | "patch" | "delete";
type Handler = (c: Context, body: Record<string, unknown>) => Awaitable<RestAnswer>;

/**
 * A fake platform's REST API, written once for every REST platform: each endpoint is authorized,
 * its JSON body parsed, a thrown refusal answered in the platform's shape, and the call put on
 * record (by `operation`) for the sessions whose objects it touched. Register the endpoints, then
 * `finish()` adds the platform's answer to everything else.
 */
export function restApi(context: DriverContext, platform: RestPlatform) {
  const api = new Hono();
  const { clock } = context;

  const answer = async (c: Context, method: Method, operation: string, handle: Handler): Promise<RestAnswer> => {
    const refused = platform.authorize(c, operation);
    if (refused) return refused;
    let body: Record<string, unknown> = {};
    if (method !== "get" && method !== "delete") {
      const text = await c.req.text();
      try {
        const parsed: unknown = text === "" ? {} : JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null) return platform.invalidJson();
        // An array (a batch) reaches its handler as it is.
        body = parsed as Record<string, unknown>;
      } catch {
        return platform.invalidJson();
      }
    }
    try {
      return await handle(c, body);
    } catch (error) {
      const refusal = platform.refusal(error);
      if (refusal) return refusal;
      throw error;
    }
  };

  const endpoint = (method: Method, path: string, operation: string, handle: Handler) =>
    api.on(method.toUpperCase(), path, async (c) => {
      const startedAt = clock();
      let result = await answer(c, method, operation, handle);
      if (platform.decorate) result = platform.decorate(result);
      const status = result.status ?? 200;
      const url = new URL(c.req.url);
      const failed = status >= 400 ? (result.body as { name?: unknown; code?: unknown } | null) : undefined;
      recordCall(
        context.events,
        platform.driver,
        result.sessions,
        {
          operation,
          method: method.toUpperCase(),
          // The platform's own path: without the prefix the fake is mounted at (`/resend`), when it is.
          path: url.pathname.replace(new RegExp(`^/${platform.driver}(?=/)`), ""),
          request: method === "get" || method === "delete" ? Object.fromEntries(url.searchParams) : await requestOf(c),
          responseStatus: status,
          response: result.body,
          error: failed ? String(failed.name ?? failed.code ?? "error") : undefined,
          durationMs: clock() - startedAt,
        },
        { unattributed: "world" },
      );
      for (const [name, value] of Object.entries(result.headers ?? {})) c.header(name, value);
      return c.json(result.body, status as 200);
    });

  return {
    api,
    endpoint,
    /** Answer every other path the way the platform answers a path it doesn't have. */
    finish() {
      api.all("*", (c) => {
        const result = platform.notFound(c);
        return c.json(result.body, (result.status ?? 404) as 404);
      });
      return api;
    },
  };
}

/** The body as the agent sent it, for the record: parsed JSON, or nothing. */
async function requestOf(c: Context): Promise<unknown> {
  try {
    const text = await c.req.text();
    return text === "" ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}
