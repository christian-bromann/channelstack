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

/** How one platform's REST API answers: its refusals' shape, what it adds to every answer, whose calls these are. */
export interface RestShape {
  /** The driver whose calls these are. */
  readonly driver: string;
  /** A refusal the handlers throw, as the platform answers it; undefined for anything else, which is a bug. */
  refusal(error: unknown): RestAnswer | undefined;
  /** What the platform adds to every answer (a request id). */
  decorate?(answer: RestAnswer): RestAnswer;
  /** A call about nothing in a session: on record for every session (`world`, the default), or for none. */
  readonly unattributed?: "world" | "drop";
}

/** A platform whose endpoints `restApi` authorizes and parses: also who may call, and what it answers a bad body or path. */
export interface RestPlatform extends RestShape {
  /** Who may call this endpoint: undefined to go on, or the platform's refusal (no key, a wrong one). */
  authorize(c: Context, operation: string): RestAnswer | undefined;
  /** A body that isn't JSON. */
  invalidJson(): RestAnswer;
  /** A path the API doesn't have. */
  notFound(c: Context): RestAnswer;
}

type Method = "get" | "post" | "put" | "patch" | "delete";

/** Where `bodyOf` keeps the body it parsed, for the record. */
const PARSED_BODY = "channelstackRestBody";

/**
 * A request's JSON body, as every REST platform reads it: an object or a list (a batch), `{}` when
 * there is none, or which way it is wrong, for the platform to refuse in its own words. A body that
 * was given is kept on the request, so the call goes on record with it.
 */
export async function bodyOf(
  c: Context,
): Promise<{ readonly body: Record<string, unknown> } | { readonly invalid: "json" | "not_object" }> {
  const text = await c.req.text();
  if (text === "") return { body: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { invalid: "json" };
  }
  if (typeof parsed !== "object" || parsed === null) return { invalid: "not_object" };
  c.set(PARSED_BODY as never, parsed as never);
  return { body: parsed as Record<string, unknown> };
}

/** The call on record: its operation and the platform's own path, what was asked and answered. */
function recordRest(
  context: DriverContext,
  platform: RestShape,
  c: Context,
  call: { operation?: string; request: unknown; status: number; response: unknown; startedAt: number },
  sessions: Iterable<string | undefined>,
  mounts: readonly string[] = [],
): void {
  let path = new URL(c.req.url).pathname.replace(new RegExp(`^/${platform.driver}(?=/)`), "");
  // The path the platform's docs use: without the prefix the fake is mounted at, or the one it is also served under.
  for (const mount of mounts) if (path.startsWith(`${mount}/`)) path = path.slice(mount.length);
  const failed =
    call.status >= 400
      ? (call.response as { name?: unknown; code?: unknown; error?: unknown; message?: unknown } | null | undefined)
      : undefined;
  recordCall(
    context.events,
    platform.driver,
    sessions,
    {
      // A platform without operation names has its method and path (`GET /repos/{owner}/{repo}` as asked).
      operation: call.operation ?? `${c.req.method} ${path}`,
      method: c.req.method,
      path,
      request: call.request,
      responseStatus: call.status,
      response: call.response,
      error:
        call.status >= 400
          ? String(failed?.name ?? failed?.code ?? failed?.error ?? failed?.message ?? call.status)
          : undefined,
      durationMs: context.clock() - call.startedAt,
    },
    { unattributed: platform.unattributed ?? "world" },
  );
}

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
      const parsed = await bodyOf(c);
      if ("invalid" in parsed) return platform.invalidJson();
      // An array (a batch) reaches its handler as it is.
      body = parsed.body;
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
      const request =
        method === "get" || method === "delete"
          ? Object.fromEntries(new URL(c.req.url).searchParams)
          : c.get(PARSED_BODY as never);
      recordRest(
        context,
        platform,
        c,
        { operation, request, status, response: result.body, startedAt },
        result.sessions,
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

/**
 * `restApi` for a platform whose routes answer Hono responses themselves, check their own
 * credentials and parse their own bodies (with `bodyOf`), as GitHub's do (the App's JWT, the
 * installation token, a permission per endpoint): `router` served at `/` and at each of `mounts`,
 * every answer decorated, a thrown refusal answered in the platform's shape (and anything else as
 * its `internal` answer, logged), and each call `recorded` for the `sessions` it touched.
 */
export function wrapRest(
  context: DriverContext,
  platform: RestShape & {
    /** What the platform answers when the fake itself fails, which is a bug. */
    internal(): RestAnswer;
  },
  router: Hono<any>,
  options: {
    sessions(c: Context): Iterable<string | undefined>;
    /** Whether this call goes on record (a platform may keep unauthenticated calls off it). Default: every call. */
    recorded?(c: Context): boolean;
    /** Other prefixes the API is served under (GitHub Enterprise's `/api/v3`). */
    mounts?: readonly string[];
  },
): Hono {
  const { clock } = context;
  const outer = new Hono();
  outer.use(async (c, next) => {
    const startedAt = clock();
    await next();
    const status = c.res.status;
    const raw = status === 204 ? "" : await c.res.clone().text();
    let response: unknown = raw;
    try {
      response = raw === "" ? undefined : JSON.parse(raw);
    } catch {
      response = raw;
    }
    const decorated = platform.decorate?.({ body: response, sessions: [], status });
    for (const [name, value] of Object.entries(decorated?.headers ?? {})) c.header(name, value);
    if (options.recorded && !options.recorded(c)) return;
    recordRest(
      context,
      platform,
      c,
      { request: c.get(PARSED_BODY as never), status, response, startedAt },
      options.sessions(c),
      options.mounts,
    );
  });
  outer.onError((error, c) => {
    const refusal = platform.refusal(error);
    if (refusal) return c.json(refusal.body, (refusal.status ?? 400) as 400);
    context.log.error(`${platform.driver} api`, { error: error instanceof Error ? error.message : String(error) });
    const internal = platform.internal();
    return c.json(internal.body, (internal.status ?? 500) as 500);
  });
  for (const mount of options.mounts ?? []) outer.route(mount, router);
  outer.route("/", router);
  return outer;
}
