import { z } from "@hono/zod-openapi";

/** The protocol's own error codes and their HTTP status. Codes are part of the spec; SDKs map them to typed exceptions. */
const CORE_ERRORS = {
  unauthorized: 401,
  invalid_argument: 400,
  not_found: 404,
  session_not_found: 404,
  internal: 500,
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

/** The one error shape routes throw. Messages must never contain tokens or upstream bodies. */
export class ProtocolError extends Error {
  readonly code: string;
  readonly status: number;
  readonly data: Record<string, unknown>;

  constructor(code: CoreErrorCode, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.status = CORE_ERRORS[code];
    this.data = data;
  }

  toBody(): ErrorBody {
    return { error: this.code, message: this.message, data: this.data };
  }
}

/**
 * A refusal from a fake platform, surfaced through the control API with the platform's own
 * error code (`not_in_channel`, `not_in_room`), the way the real platform would refuse it.
 */
export class PlatformError extends ProtocolError {
  override readonly code: string;
  override readonly status: number;

  constructor(code: string, status: number, message: string, data: Record<string, unknown> = {}) {
    super("invalid_argument", message, data);
    this.name = "PlatformError";
    this.code = code;
    this.status = status;
  }
}
