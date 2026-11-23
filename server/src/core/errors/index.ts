import { z } from "@hono/zod-openapi";

/** The protocol's own error codes and their HTTP status. Codes are part of the spec; SDKs map them to typed exceptions. */
const CORE_ERRORS = {
  unauthorized: 401,
  invalid_argument: 400,
  not_found: 404,
  session_not_found: 404,
  internal: 500,
  // Live mode (implementation plan 4.4).
  /** The operation isn't built in the fake yet. */
  unsupported_in_fake: 501,
  /** The operation has no live counterpart, or not yet: delivery chaos, a person's Re-run. */
  unsupported_in_live: 501,
  /** A live action needs something missing: a person's token, the browser actor, proxy mode. */
  action_requires: 422,
  /** The live workspace, org, team or Notion workspace isn't in its `CHANNELSTACK_LIVE_*` allowlist. */
  live_not_allowlisted: 403,
  /** A fake person acts in a live workspace. */
  fake_actor_in_live_world: 409,
  /** A person's token belongs to a different workspace than the app. */
  cross_workspace_credential: 400,
} as const;

export type CoreErrorCode = keyof typeof CORE_ERRORS;

export const ErrorBody = z
  .object({
    error: z.string().openapi({ description: "A stable error code.", example: "not_found" }),
    message: z.string(),
    data: z.record(z.string(), z.unknown()),
  })
  .openapi("Error");

export type ErrorBody = z.infer<typeof ErrorBody>;

/**
 * A refusal from a fake platform, surfaced through the control API with the platform's own
 * error code and status (`not_in_channel`, `not_in_room`), the way the real platform would refuse it.
 */
export interface PlatformRefusal {
  platform: string;
  status: number;
}

/** The one error shape routes throw. Messages must never contain tokens or upstream bodies. */
export class ProtocolError extends Error {
  readonly code: string;
  readonly status: number;
  readonly data: Record<string, unknown>;

  constructor(code: CoreErrorCode | PlatformRefusal, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.name = "ProtocolError";
    this.code = typeof code === "string" ? code : code.platform;
    this.status = typeof code === "string" ? CORE_ERRORS[code] : code.status;
    this.data = data;
  }

  toBody(): ErrorBody {
    return { error: this.code, message: this.message, data: this.data };
  }
}
