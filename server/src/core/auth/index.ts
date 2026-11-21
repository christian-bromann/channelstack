import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

import { ProtocolError } from "../errors/index.ts";
import { randomToken } from "../secrets/index.ts";
import { constantTimeEqual } from "../signing/hmac.ts";
import { UI_COOKIE, type UiAccess } from "./ui.ts";

/** A new control API bearer token, from the CSPRNG. One per server start. */
export function createBearerToken(): string {
  return randomToken(32);
}

/** The token from an `Authorization: Bearer …` header, if there is one. */
export function bearerFrom(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match?.[1];
}

/**
 * Refuses every request that doesn't carry the server's bearer token (compared in constant time).
 * A browser that opened a login link is let through for the reads the UI shows, and only those,
 * and what it gets is scrubbed first: nothing the UI shows may contain a token.
 */
export function requireAccess(options: {
  token: string;
  ui: UiAccess;
  /** The path the control API is mounted at. */
  prefix: string;
  /** Removes tokens and secrets from a response body. */
  scrub: (body: unknown) => unknown;
}): MiddlewareHandler {
  return async (c, next) => {
    const presented = bearerFrom(c.req.header("authorization"));
    if (presented !== undefined && constantTimeEqual(presented, options.token)) return next();
    const path = c.req.path.startsWith(options.prefix) ? c.req.path.slice(options.prefix.length) : c.req.path;
    if (!options.ui.allows(getCookie(c, UI_COOKIE), c.req.method, path)) {
      throw new ProtocolError("unauthorized", "Missing or wrong bearer token");
    }
    await next();
    if (c.res.headers.get("content-type")?.startsWith("application/json")) {
      c.res = Response.json(options.scrub(await c.res.json()), { status: c.res.status });
    }
  };
}
