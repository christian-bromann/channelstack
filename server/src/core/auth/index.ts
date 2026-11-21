import type { MiddlewareHandler } from "hono";

import { ProtocolError } from "../errors/index.ts";
import { randomToken } from "../secrets/index.ts";
import { constantTimeEqual } from "../signing/hmac.ts";

/** A new control API bearer token, from the CSPRNG. One per server start. */
export function createBearerToken(): string {
  return randomToken(32);
}

/** The token from an `Authorization: Bearer …` header, if there is one. */
export function bearerFrom(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match?.[1];
}

/** Refuses every request that doesn't carry the server's bearer token. The comparison is constant-time. */
export function requireBearer(token: string): MiddlewareHandler {
  return async (c, next) => {
    const presented = bearerFrom(c.req.header("authorization"));
    if (presented === undefined || !constantTimeEqual(presented, token)) {
      throw new ProtocolError("unauthorized", "Missing or wrong bearer token");
    }
    await next();
  };
}
