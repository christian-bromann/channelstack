import { iso } from "../../core/clock/index.ts";
import { formatMailbox } from "../../core/email/index.ts";
import type { ResendEmailRecord } from "./world.ts";

type Json = Record<string, unknown>;

/** A time as `GET /emails` writes it, Postgres's way: `2023-04-03 22:13:42.674981+00`. */
export const resendTime = (ms: number): string => `${iso(ms).replace("T", " ").replace("Z", "")}000+00`;

/** The webhook events the agent's team is subscribed to, as a new webhook in Resend's dashboard is. */
export const EMAIL_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.suppressed",
  "email.received",
] as const;

const addresses = (mailboxes: ResendEmailRecord["to"]) => mailboxes.map((mailbox) => mailbox.address);

/**
 * Builders for what Resend sends and answers, each the shape of a schema in Resend's OpenAPI
 * description (`resend-openapi`), which the tests hold them to (exit check 8.3).
 */
export const resendPayloads = {
  /** `email.received`: the team got an email. Only its metadata: the body comes from `GET /emails/receiving/{id}`. */
  received(email: ResendEmailRecord, atMs: number): Json {
    return {
      type: "email.received",
      created_at: iso(atMs),
      data: {
        email_id: email.id,
        created_at: iso(email.createdAt),
        from: email.from.address,
        to: addresses(email.to),
        bcc: addresses(email.bcc),
        cc: addresses(email.cc),
        message_id: email.messageId,
        subject: email.subject,
        attachments: [],
      },
    };
  },

  /** `email.sent`, `email.delivered`, …: what happened to an email the team sent. */
  outbound(type: string, email: ResendEmailRecord, atMs: number, extra: Json = {}): Json {
    const headers = Object.entries(email.headers).map(([name, value]) => ({ name, value }));
    return {
      type,
      created_at: iso(atMs),
      data: {
        email_id: email.id,
        created_at: iso(email.createdAt),
        from: formatMailbox(email.from),
        to: addresses(email.to),
        subject: email.subject,
        ...(Object.keys(email.tags).length === 0 ? {} : { tags: email.tags }),
        // Omitted when the email set no headers of its own.
        ...(headers.length === 0 ? {} : { headers }),
        ...extra,
      },
    };
  },

  /** `GET /emails/receiving/{id}`: a received email, body and headers. */
  receivedEmail(email: ResendEmailRecord): Json {
    return {
      object: "email",
      id: email.id,
      to: addresses(email.to),
      from: formatMailbox(email.from),
      created_at: iso(email.createdAt),
      subject: email.subject,
      message_id: email.messageId,
      bcc: addresses(email.bcc),
      cc: addresses(email.cc),
      reply_to: addresses(email.replyTo),
      html: email.html ?? null,
      text: email.text ?? null,
      headers: {
        from: formatMailbox(email.from),
        to: email.to.map(formatMailbox).join(", "),
        subject: email.subject,
        "message-id": email.messageId,
        ...(email.inReplyTo ? { "in-reply-to": email.inReplyTo } : {}),
        ...(email.references.length > 0 ? { references: email.references.join(" ") } : {}),
        ...email.headers,
      },
      attachments: [],
    };
  },

  /** An email in `GET /receiving`'s list: the same, without the body and headers. */
  receivedSummary(email: ResendEmailRecord): Json {
    const { html: _html, text: _text, headers: _headers, ...summary } = resendPayloads.receivedEmail(email);
    return summary;
  },

  /** `GET /emails/{id}`: an email the team sent, with what happened to it last. */
  sentEmail(email: ResendEmailRecord): Json {
    return {
      object: "email",
      id: email.id,
      to: addresses(email.to),
      from: formatMailbox(email.from),
      created_at: resendTime(email.createdAt),
      subject: email.subject,
      html: email.html ?? null,
      text: email.text ?? null,
      bcc: addresses(email.bcc),
      cc: addresses(email.cc),
      reply_to: addresses(email.replyTo),
      last_event: email.lastEvent ?? "sent",
      scheduled_at: null,
      tags: Object.entries(email.tags).map(([name, value]) => ({ name, value })),
    };
  },
};
