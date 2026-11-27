import { createHash } from "node:crypto";

import type { Context, Hono } from "hono";

import { bearerFrom } from "../../../core/auth/index.ts";
import { type RestAnswer, restApi } from "../../../core/fake/endpoint.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { constantTimeEqual } from "../../../core/signing/hmac.ts";
import { resendPayloads } from "../payloads.ts";
import type { ResendAppRecord, ResendEmailRecord } from "../world.ts";
import { createDownloads } from "./downloads.ts";
import { type AttachmentFile, type FakeResendWorld, ResendApiError, type SendInput } from "./world.ts";

/** Resend's default rate limit: 10 requests a second. */
const RATE_LIMIT = 10;
/** Where a call keeps the team its key is: each key answers as its own team. */
const TEAM = "channelstackResendTeam";
/** When the fake team's domain was verified: before any test. */
const DOMAIN_CREATED_AT = "2026-01-01T00:00:00.000Z";
/** How long Resend keeps an idempotency key: 24 hours. */
const IDEMPOTENCY_MS = 24 * 3_600_000;
/** How long the fake waits for a `path` attachment's file. */
const FETCH_MS = 10_000;
/** The most an email's attachments may be: 40 MB once base64-encoded, Resend's limit for an email. */
const ATTACHMENTS_MAX_ENCODED = 40 * 1024 * 1024;
/** How long a file is in base64, as the limit counts it. */
const encodedLength = (bytes: number) => Math.ceil(bytes / 3) * 4;

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
    attachments: [],
  };
}

/** Refused as Resend refuses an attachment it can't take. */
const invalidAttachment = (message: string) => new ResendApiError(422, "invalid_attachment", message);
const overLimit = () => invalidAttachment("The email's attachments are over the 40 MB limit.");

/**
 * The files `path` attachments name, fetched as Resend fetches them: over HTTP(S), within ten
 * seconds and the size limit (`budget`, in base64 bytes). Resend fetches after it answers, and fails the email when it can't;
 * the fake refuses the send instead.
 */
async function fetchFile(path: string, budget: number): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    throw invalidAttachment(`The attachment \`path\` "${path}" is not a URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalidAttachment("The attachment `path` must be an http or https URL.");
  }
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS) });
  } catch {
    throw invalidAttachment(`The fake couldn't fetch the attachment at ${url.origin}${url.pathname}.`);
  }
  if (!response.ok) {
    throw invalidAttachment(
      `The fake couldn't fetch the attachment at ${url.origin}${url.pathname}: ${response.status}.`,
    );
  }
  if (encodedLength(Number(response.headers.get("content-length") ?? 0)) > budget) {
    await response.body?.cancel();
    throw overLimit();
  }
  // Read as it comes, and stop once it is over the limit: a body without a length can be any size.
  const chunks: Uint8Array[] = [];
  let read = 0;
  try {
    for await (const chunk of response.body ?? []) {
      read += chunk.byteLength;
      if (encodedLength(read) > budget) throw overLimit();
      chunks.push(chunk);
    }
  } catch (error) {
    // The connection dropped, or the time ran out, while the file came.
    if (error instanceof ResendApiError) throw error;
    throw invalidAttachment(`The fake couldn't fetch the attachment at ${url.origin}${url.pathname}.`);
  }
  return Buffer.concat(chunks);
}

/**
 * `POST /emails`'s attachments as Resend keeps them: `content` as base64 or a list of bytes (the
 * Python SDK's), or a `path` it fetches; named `attachment-<n>` without a `filename`, and of type
 * `application/octet-stream` without a `content_type` (found against Resend).
 */
async function attachmentsOf(value: unknown): Promise<AttachmentFile[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new ResendApiError(422, "validation_error", "The `attachments` field must be an array.");
  const files: AttachmentFile[] = [];
  let budget = ATTACHMENTS_MAX_ENCODED;
  for (const [at, item] of value.entries()) {
    const attachment = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const { content, path } = attachment;
    let bytes: Uint8Array;
    if (typeof content === "string") bytes = Buffer.from(content, "base64");
    else if (Array.isArray(content) && content.every((byte) => Number.isInteger(byte) && byte >= 0 && byte < 256)) {
      bytes = Uint8Array.from(content as number[]);
    } else if (typeof path === "string" && path !== "") bytes = await fetchFile(path, budget);
    else throw invalidAttachment("Attachment must have either a `content` or `path`.");
    budget -= encodedLength(bytes.byteLength);
    if (budget < 0) throw overLimit();
    files.push({
      filename:
        typeof attachment.filename === "string" && attachment.filename !== ""
          ? attachment.filename
          : `attachment-${at}`,
      contentType:
        typeof attachment.content_type === "string" && attachment.content_type !== ""
          ? attachment.content_type
          : "application/octet-stream",
      contentId:
        typeof attachment.content_id === "string" && attachment.content_id !== "" ? attachment.content_id : undefined,
      content: bytes,
    });
  }
  return files;
}

/** A page of a list, in the order given, as Resend pages them: `limit` (1–100, default 20), `after` or `before` an id. */
function page<Item extends { readonly id: string }>(c: Context, items: readonly Item[], show: (item: Item) => unknown) {
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
  const after = c.req.query("after");
  const before = c.req.query("before");
  if (after !== undefined && before !== undefined) {
    throw new ResendApiError(422, "validation_error", "Use either `after` or `before`, not both.");
  }
  const from = after !== undefined ? items.findIndex((item) => item.id === after) + 1 : 0;
  const until = before !== undefined ? items.findIndex((item) => item.id === before) : items.length;
  const window = items.slice(from, until < 0 ? items.length : until);
  return { object: "list", has_more: window.length > limit, data: window.slice(0, limit).map(show) };
}

/**
 * Resend's REST API as each team sees it (`resend` SDK, `RESEND_BASE_URL`): sending, and reading
 * what it sent and received. Every call needs a team's API key, answers as that team (the agent's,
 * or another app's: decision 0027), and is on record for the
 * sessions whose emails it touched, by the SDK's method name (`emails.send`).
 */
export function createResendApi(context: DriverContext, world: FakeResendWorld): Hono {
  const { store } = world;
  const { clock } = context;
  const downloads = createDownloads(context, store);
  /** Each session's calls in the last second: Resend's limit is per team; here each test is its own. */
  const recent = new Map<string, number[]>();
  const used = new Map<string, { request: string; answer: RestAnswer; at: number }>();
  /** The keys of sends still under way: their files are being fetched. */
  const sending = new Set<string>();

  const { api, endpoint, finish } = restApi(context, {
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
      // Each key is one team's: the call is that team's (decision 0027).
      const team = store.apps.all().find((app) => constantTimeEqual(key, context.apps.secret(app.name, "apiKey")));
      if (!team) return errorAnswer(400, "validation_error", "API key is invalid");
      c.set(TEAM as never, team as never);
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
      ...errorAnswer(
        429,
        "rate_limit_exceeded",
        "Too many requests. You can only make 10 requests per second. See rate limit response headers for more information. Or contact support to increase rate limit.",
      ),
      headers: {
        "retry-after": "1",
        "ratelimit-limit": String(RATE_LIMIT),
        "ratelimit-remaining": "0",
        "ratelimit-reset": "1",
      },
    };
  };

  /** Send once per idempotency key: the same request again gets the same answer, another one a 409. */
  const once = async (
    c: Context,
    body: Record<string, unknown>,
    send: () => RestAnswer | Promise<RestAnswer>,
  ): Promise<RestAnswer> => {
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
    if (sending.has(key)) {
      throw new ResendApiError(
        409,
        "concurrent_idempotent_requests",
        "Same idempotency key used while original request is still in progress.",
      );
    }
    // Until it is sent, or refused, the same key again is refused: it would send twice.
    sending.add(key);
    try {
      const answer = await send();
      used.set(key, { request, answer, at: clock() });
      return answer;
    } finally {
      sending.delete(key);
    }
  };

  /** The team whose key made the call. */
  const teamOf = (c: Context) => c.get(TEAM as never) as ResendAppRecord;
  const sentEmail = (c: Context, id: string) => {
    const email = store.emails.find(id);
    if (!email || !world.sentBy(teamOf(c), email)) throw new ResendApiError(404, "not_found", "Email not found");
    return email;
  };
  const receivedEmail = (c: Context, id: string) => {
    const email = store.emails.find(id);
    if (!email || !world.receivedBy(teamOf(c), email)) throw new ResendApiError(404, "not_found", "Email not found");
    return email;
  };

  endpoint("post", "/emails", "emails.send", async (c, body) => {
    const input = sendInput(body);
    // Over the limit, nothing is sent and the key isn't used up: the agent may send again.
    const refused = limited(world.checkSend(input, teamOf(c)).session);
    if (refused) return refused;
    // The attachments are read last, and only for a send that happens: not for a refused one, nor a repeated key.
    return once(c, body, async () => {
      const email = await world.appSends({ ...input, attachments: await attachmentsOf(body.attachments) }, teamOf(c));
      return { body: { id: email.id }, sessions: [world.sessionOf(email)] };
    });
  });

  endpoint("post", "/emails/batch", "batch.send", async (c, body) => {
    const items: unknown = body;
    if (!Array.isArray(items))
      throw new ResendApiError(422, "validation_error", "The body must be an array of emails.");
    if (items.length > 100) throw new ResendApiError(422, "validation_error", "A batch has at most 100 emails.");
    // A batch takes no attachments: Resend sends its emails without them (found against Resend).
    const inputs = items.map((item) => sendInput(item as Record<string, unknown>));
    // Every email is checked before any is sent: a batch is sent whole, or not at all.
    const checked = inputs.map((input) => world.checkSend(input, teamOf(c)));
    const refused = limited(checked[0]?.session);
    if (refused) return refused;
    const emails: ResendEmailRecord[] = [];
    for (const input of inputs) emails.push(await world.appSends(input, teamOf(c)));
    return { body: { data: emails.map((email) => ({ id: email.id })) }, sessions: emails.map(world.sessionOf) };
  });

  endpoint("get", "/emails", "emails.list", (c) => {
    const sent = store.emails.values().filter((email) => world.sentBy(teamOf(c), email));
    // Newest first, as Resend lists.
    return { body: page(c, sent.reverse(), resendPayloads.sentEmail), sessions: [] };
  });

  // Registered before `/emails/:id`, which would take `receiving` for an id.
  endpoint("get", "/emails/receiving", "emails.receiving.list", (c) => {
    const wanted = c.req.queries("to")?.map((address) => address.toLowerCase());
    const received = store.emails
      .values()
      .filter((email) => world.receivedBy(teamOf(c), email))
      .filter((email) => wanted === undefined || email.to.some((mailbox) => wanted.includes(mailbox.address)));
    return {
      body: page(c, [...received].reverse(), resendPayloads.receivedSummary),
      sessions: received.map(world.sessionOf),
    };
  });

  endpoint("get", "/emails/receiving/:id", "emails.receiving.get", (c) => {
    const email = receivedEmail(c, c.req.param("id") ?? "");
    return {
      body: resendPayloads.receivedEmail(email, downloads.link(email, "raw")),
      sessions: [world.sessionOf(email)],
    };
  });

  /** An email's attachments, each with the link to its content. */
  const attachmentList = (c: Context, email: ResendEmailRecord): RestAnswer => ({
    body: page(c, email.attachments, (attachment) =>
      resendPayloads.attachment(attachment, downloads.link(email, { attachment: attachment.id })),
    ),
    sessions: [world.sessionOf(email)],
  });
  /** One of an email's attachments, with the link to its content. */
  const attachmentOne = (email: ResendEmailRecord, id: string): RestAnswer => {
    const attachment = email.attachments.find((each) => each.id === id);
    if (!attachment) throw new ResendApiError(404, "not_found", "Attachment not found");
    return {
      body: {
        object: "attachment",
        ...resendPayloads.attachment(attachment, downloads.link(email, { attachment: attachment.id })),
      },
      sessions: [world.sessionOf(email)],
    };
  };

  endpoint("get", "/emails/receiving/:id/attachments", "emails.receiving.attachments.list", (c) =>
    attachmentList(c, receivedEmail(c, c.req.param("id") ?? "")),
  );

  endpoint("get", "/emails/receiving/:id/attachments/:attachment", "emails.receiving.attachments.get", (c) =>
    attachmentOne(receivedEmail(c, c.req.param("id") ?? ""), c.req.param("attachment") ?? ""),
  );

  endpoint("get", "/emails/:id", "emails.get", (c) => {
    const email = sentEmail(c, c.req.param("id") ?? "");
    return { body: resendPayloads.sentEmail(email), sessions: [world.sessionOf(email)] };
  });

  endpoint("get", "/emails/:id/attachments", "emails.attachments.list", (c) =>
    attachmentList(c, sentEmail(c, c.req.param("id") ?? "")),
  );

  endpoint("get", "/emails/:id/attachments/:attachment", "emails.attachments.get", (c) =>
    attachmentOne(sentEmail(c, c.req.param("id") ?? ""), c.req.param("attachment") ?? ""),
  );

  // A team sees its own domain only.
  endpoint("get", "/domains", "domains.list", (c) => ({
    body: {
      object: "list",
      has_more: false,
      data: [
        {
          id: teamOf(c).domainId,
          name: teamOf(c).domain,
          status: "verified",
          created_at: DOMAIN_CREATED_AT,
          region: "us-east-1",
          capabilities: { sending: "enabled", receiving: "enabled" },
        },
      ],
    },
    sessions: [],
  }));

  downloads.serve(api);
  return finish();
}
