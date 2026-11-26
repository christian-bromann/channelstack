import { iso } from "../../core/clock/index.ts";
import { type EmailAttachment, formatMailbox } from "../../core/email/index.ts";
import { mimeHeaders } from "../../core/email/mime.ts";
import type { DownloadLink } from "./fake/downloads.ts";
import type { ResendEmailRecord } from "./world.ts";

type Json = Record<string, unknown>;

/** A time as `GET /emails` writes it, Postgres's way: `2023-04-03 22:13:42.674981+00`. */
const resendTime = (ms: number): string => `${iso(ms).replace("T", " ").replace("Z", "")}000+00`;

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

/** An attachment as a webhook names it: inline when an HTML body names it by its `Content-ID`. */
const attachmentEvent = (attachment: EmailAttachment): Json => ({
  id: attachment.id,
  filename: attachment.filename,
  content_type: attachment.contentType,
  content_disposition: attachment.contentId === undefined ? "attachment" : "inline",
  ...(attachment.contentId === undefined ? {} : { content_id: attachment.contentId }),
});

/** An attachment as an email lists it: with its size. */
const attachmentSummary = (attachment: EmailAttachment): Json => ({
  ...attachmentEvent(attachment),
  size: attachment.size,
});

/**
 * A message's headers as Resend answers them: keyed by their lowercase names, the first of a name
 * (the newest `Received`) kept.
 */
function headersOf(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { name, value } of mimeHeaders(raw)) headers[name.toLowerCase()] ??= value;
  return headers;
}

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
        // The team's own addresses the email was for.
        received_for: addresses(email.to),
        attachments: email.attachments.map(attachmentEvent),
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
        message_id: email.messageId,
        ...(Object.keys(email.tags).length === 0 ? {} : { tags: email.tags }),
        // Omitted when the email set no headers of its own.
        ...(headers.length === 0 ? {} : { headers }),
        ...extra,
      },
    };
  },

  /** An email in `GET /receiving`'s list: who it is from and to, and its attachments; no body, headers or raw message. */
  receivedSummary(email: ResendEmailRecord): Json {
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
      html_format: "data_uri",
      received_for: addresses(email.to),
      // The checks a receiving mail server makes; mail in the fake passes them.
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
      attachments: email.attachments.map(attachmentSummary),
    };
  },

  /** `GET /emails/receiving/{id}`: a received email, body and headers, and the link to its raw message. */
  receivedEmail(email: ResendEmailRecord, raw: DownloadLink): Json {
    return {
      ...resendPayloads.receivedSummary(email),
      html: email.html ?? null,
      text: email.text ?? null,
      raw,
      // The headers of the message as it was received.
      headers: headersOf(email.raw ?? ""),
    };
  },

  /** An attachment with the link to its content, as `GET /emails/{id}/attachments` and the received email's list it. */
  attachment(attachment: EmailAttachment, link: DownloadLink): Json {
    return { ...attachmentSummary(attachment), ...link };
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
      // Only the bodies the email has: Resend's description has no null for either.
      ...(email.html === undefined ? {} : { html: email.html }),
      ...(email.text === undefined ? {} : { text: email.text }),
      bcc: addresses(email.bcc),
      cc: addresses(email.cc),
      reply_to: addresses(email.replyTo),
      last_event: email.lastEvent ?? "sent",
      scheduled_at: null,
      tags: Object.entries(email.tags).map(([name, value]) => ({ name, value })),
    };
  },
};
