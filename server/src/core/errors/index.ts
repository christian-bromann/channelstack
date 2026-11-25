import { z } from "@hono/zod-openapi";

/**
 * The protocol's own error codes: their HTTP status, and what they mean. Codes are part of the spec
 * (`x-channelstack-errors`), where SDKs map them to typed exceptions and the docs explain them.
 */
export const CORE_ERRORS = {
  unauthorized: {
    status: 401,
    description: "The request has no valid bearer token: the one in `server.json`, or `CHANNELSTACK_TOKEN`.",
  },
  invalid_argument: { status: 400, description: "An argument is missing, or has the wrong type or shape." },
  not_found: {
    status: 404,
    description: "The handle isn't there: it was removed, or belongs to another session.",
  },
  session_not_found: { status: 404, description: "The session was closed, or never existed." },
  internal: { status: 500, description: "Something failed inside channelstack. The message says what." },
  // Live mode (implementation plan 4.4).
  unsupported_in_fake: { status: 501, description: "The operation isn't built in the fake yet." },
  unsupported_in_live: {
    status: 501,
    description:
      "The operation has no live counterpart, or not yet: delivery chaos, a person's Re-run. A test is skipped for it.",
  },
  action_requires: {
    status: 422,
    description:
      "A live action needs a piece this run doesn't have: the browser actor, or proxy mode. A test is skipped for it.",
  },
  live_misconfigured: {
    status: 412,
    description:
      "Live mode is set up wrong: credentials set in part, a token of the wrong kind, a person without a token under `CHANNELSTACK_REALITY=live`. A test fails for it, so a broken nightly run goes red.",
  },
  live_not_allowlisted: {
    status: 403,
    description:
      "The live workspace, org or team isn't in its `CHANNELSTACK_LIVE_*` allowlist. Nothing was done there.",
  },
  fake_actor_in_live_world: { status: 409, description: "A fake person acts in a live workspace." },
  cross_workspace_credential: {
    status: 400,
    description: "A person's token belongs to a different workspace than the app's.",
  },
} as const satisfies Record<string, { status: number; description: string }>;

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
    this.status = typeof code === "string" ? CORE_ERRORS[code].status : code.status;
    this.data = data;
  }

  toBody(): ErrorBody {
    return { error: this.code, message: this.message, data: this.data };
  }
}
