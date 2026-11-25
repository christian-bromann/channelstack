import { createHash } from "node:crypto";

import type { Context, Hono } from "hono";

import { bearerFrom } from "../../../core/auth/index.ts";
import { type RestAnswer, restApi } from "../../../core/fake/endpoint.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { constantTimeEqual } from "../../../core/signing/hmac.ts";
import { resendPayloads } from "../payloads.ts";
import type { ResendEmailRecord } from "../world.ts";
import { type FakeResendWorld, ResendApiError, type SendInput } from "./world.ts";

/** Resend's default rate limit: 10 requests a second. */
const RATE_LIMIT = 10;
/** When the fake team's domain was verified: before any test. */
const DOMAIN_CREATED_AT = "2026-01-01T00:00:00.000Z";
/** How long Resend keeps an idempotency key: 24 hours. */
const IDEMPOTENCY_MS = 24 * 3_600_000;

/** An error as Resend answers it. */
const errorAnswer = (status: number, name: string, message: string): RestAnswer => ({
  body: { statusCode: status, name, message },
  sessions: [],
  status,
});

/** An address field as Resend takes it: one address, or a list. */
const list = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];

/** `POST /emails`'s body as the world takes it. */
function sendInput(body: Record<string, unknown>): SendInput {
  if (typeof body.from !== "string") throw new ResendApiError(422, "missing_required_field", "Missing `from` field.");
  if (body.to === undefined) throw new ResendApiError(422, "missing_required_field", "Missing `to` field.");
  if (typeof body.subject !== "string") {
    throw new ResendApiError(422, "missing_required_field", "Missing `subject` field.");
  }
  const tags = Array.isArray(body.tags)
    ? Object.fromEntries(
        body.tags.flatMap((tag) =>
          typeof tag === "object" && tag !== null && typeof tag.name === "string" && typeof tag.value === "string"
            ? [[tag.name, tag.value]]
            : [],
        ),
      )
    : {};
  const headers =
    typeof body.headers === "object" && body.headers !== null
      ? Object.fromEntries(Object.entries(body.headers).filter(([, value]) => typeof value === "string"))
      : {};
  return {
    from: body.from,
    to: list(body.to),
    cc: list(body.cc),
    bcc: list(body.bcc),
    replyTo: list(body.reply_to),
    subject: body.subject,
    text: typeof body.text === "string" && body.text !== "" ? body.text : undefined,
    html: typeof body.html === "string" ? body.html : undefined,
    headers: headers as Record<string, string>,
    tags,
  };
}

/** A page of a list, as Resend pages them: `limit` (1–100, default 20), `after` or `before` an id. */
function page(c: Context, items: readonly ResendEmailRecord[], show: (email: ResendEmailRecord) => unknown) {
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
  const after = c.req.query("after");
  const before = c.req.query("before");
  if (after !== undefined && before !== undefined) {
    throw new ResendApiError(422, "validation_error", "Use either `after` or `before`, not both.");
  }
  // Newest first, as Resend lists.
  const newest = [...items].reverse();
  const from = after !== undefined ? newest.findIndex((email) => email.id === after) + 1 : 0;
  const until = before !== undefined ? newest.findIndex((email) => email.id === before) : newest.length;
  const window = newest.slice(from, until < 0 ? newest.length : until);
  return { object: "list", has_more: window.length > limit, data: window.slice(0, limit).map(show) };
}

/**
 * Resend's REST API as the agent's team sees it (`resend` SDK, `RESEND_BASE_URL`): sending, and
 * reading what it sent and received. Every call needs the team's API key, and is on record for the
 * sessions whose emails it touched, by the SDK's method name (`emails.send`).
 */
export function createResendApi(context: DriverContext, world: FakeResendWorld): Hono {
  const { store } = world;
  const { clock } = context;
  /** Each session's calls in the last second: Resend's limit is per team; here each test is its own. */
  const recent = new Map<string, number[]>();
  const used = new Map<string, { request: string; answer: RestAnswer; at: number }>();

  const { endpoint, finish } = restApi(context, {
    driver: "resend",
    authorize(c) {
      const key = bearerFrom(c.req.header("authorization"));
      if (key === undefined) {
        return errorAnswer(
          401,
          "missing_api_key",
          "Missing API key in the authorization header. Include the following header in the request: Authorization: Bearer YOUR_API_KEY",
        );
      }
      if (!constantTimeEqual(key, context.secret("apiKey")))
        return errorAnswer(400, "validation_error", "API key is invalid");
      return undefined;
    },
    refusal: (error) =>
      error instanceof ResendApiError ? errorAnswer(error.status, error.errorName, error.message) : undefined,
    invalidJson: () => errorAnswer(400, "invalid_json", "The request body is not valid JSON."),
    notFound: () => errorAnswer(404, "not_found", "The requested endpoint does not exist."),
  });

  /** Count a call against its session's limit; over it, Resend answers 429. */
  const limited = (session: string | undefined): RestAnswer | undefined => {
    const key = session ?? "";
    const now = clock();
    const calls = (recent.get(key) ?? []).filter((at) => now - at < 1000);
    calls.push(now);
    recent.set(key, calls);
    if (calls.length <= RATE_LIMIT) return undefined;
    return {
      ...errorAnswer(429, "rate_limit_exceeded", "Too many requests. You can only make 10 requests per second."),
      headers: { "retry-after": "1", "ratelimit-limit": String(RATE_LIMIT), "ratelimit-remaining": "0" },
    };
  };

  /** Send once per idempotency key: the same request again gets the same answer, another one a 409. */
  const once = (c: Context, body: Record<string, unknown>, send: () => RestAnswer): RestAnswer => {
    const key = c.req.header("idempotency-key");
    if (key === undefined) return send();
    if (key.length === 0 || key.length > 256) {
      throw new ResendApiError(400, "invalid_idempotency_key", "The key must be between 1 and 256 characters.");
    }
    const request = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const earlier = used.get(key);
    if (earlier && clock() - earlier.at < IDEMPOTENCY_MS) {
      if (earlier.request !== request) {
        throw new ResendApiError(
          409,
          "invalid_idempotent_request",
          "Same idempotency key used with a different request payload. Change your idempotency key or payload.",
        );
      }
      return earlier.answer;
    }
    const answer = send();
    used.set(key, { request, answer, at: clock() });
    return answer;
  };

  const sentEmail = (id: string) => {
    const email = store.emails.find(id);
    if (email?.direction !== "sent") throw new ResendApiError(404, "not_found", "Email not found");
    return email;
  };
  const receivedEmail = (id: string) => {
    const email = store.emails.find(id);
    if (email?.direction !== "received") throw new ResendApiError(404, "not_found", "Email not found");
    return email;
  };

  endpoint("post", "/emails", "emails.send", (c, body) =>
    once(c, body, () => {
      const email = world.appSends(sendInput(body));
      const session = world.sessionOf(email);
      return limited(session) ?? { body: { id: email.id }, sessions: [session] };
    }),
  );

  endpoint("post", "/emails/batch", "batch.send", (_c, body) => {
    const items: unknown = body;
    if (!Array.isArray(items))
      throw new ResendApiError(422, "validation_error", "The body must be an array of emails.");
    if (items.length > 100) throw new ResendApiError(422, "validation_error", "A batch has at most 100 emails.");
    const inputs = items.map((item) => sendInput(item as Record<string, unknown>));
    const emails = inputs.map((input) => world.appSends(input));
    const sessions = emails.map(world.sessionOf);
    return limited(sessions[0]) ?? { body: { data: emails.map((email) => ({ id: email.id })) }, sessions };
  });

  endpoint("get", "/emails", "emails.list", (c) => {
    const sent = store.emails.values().filter((email) => email.direction === "sent");
    return { body: page(c, sent, resendPayloads.sentEmail), sessions: [] };
  });

  // Registered before `/emails/:id`, which would take `receiving` for an id.
  endpoint("get", "/emails/receiving", "emails.receiving.list", (c) => {
    const wanted = c.req.queries("to")?.map((address) => address.toLowerCase());
    const received = store.emails
      .values()
      .filter((email) => email.direction === "received")
      .filter((email) => wanted === undefined || email.to.some((mailbox) => wanted.includes(mailbox.address)));
    return { body: page(c, received, resendPayloads.receivedSummary), sessions: received.map(world.sessionOf) };
  });

  endpoint("get", "/emails/receiving/:id", "emails.receiving.get", (c) => {
    const email = receivedEmail(c.req.param("id") ?? "");
    return { body: resendPayloads.receivedEmail(email), sessions: [world.sessionOf(email)] };
  });

  endpoint("get", "/emails/receiving/:id/attachments", "emails.receiving.attachments.list", (c) => {
    const email = receivedEmail(c.req.param("id") ?? "");
    return { body: { object: "list", has_more: false, data: [] }, sessions: [world.sessionOf(email)] };
  });

  endpoint("get", "/emails/:id", "emails.get", (c) => {
    const email = sentEmail(c.req.param("id") ?? "");
    return { body: resendPayloads.sentEmail(email), sessions: [world.sessionOf(email)] };
  });

  endpoint("get", "/domains", "domains.list", () => ({
    body: {
      object: "list",
      has_more: false,
      data: [
        {
          id: store.app.domainId,
          name: store.app.domain,
          status: "verified",
          created_at: DOMAIN_CREATED_AT,
          region: "us-east-1",
          capabilities: { sending: "enabled", receiving: "enabled" },
        },
      ],
    },
    sessions: [],
  }));

  return finish();
}
