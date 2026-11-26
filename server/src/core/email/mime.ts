import MailComposer from "nodemailer/lib/mail-composer/index.js";
import PostalMime, { type Address, decodeWords } from "postal-mime";

import { type EmailAttachment, formatMailbox, type Mailbox, messageIdsIn } from "./index.ts";

/**
 * Email as it travels: RFC 5322 messages, built with `nodemailer`'s composer and read with
 * `postal-mime`. A platform that hands the agent the message itself (Gmail's `raw`) builds it
 * here, and reads here what the agent wrote.
 */

/** A header as a message carries it: its name as written, its value unfolded. */
export interface MimeHeader {
  readonly name: string;
  readonly value: string;
}

/** What a message says, as a fake keeps it. */
export interface MimeMessage {
  readonly from: Mailbox;
  readonly to: readonly Mailbox[];
  readonly cc: readonly Mailbox[];
  readonly bcc: readonly Mailbox[];
  readonly replyTo: readonly Mailbox[];
  readonly subject: string;
  readonly text: string | undefined;
  readonly html: string | undefined;
  readonly messageId: string;
  readonly inReplyTo: string | undefined;
  readonly references: readonly string[];
}

/**
 * Build a message: the bytes a mail server would send, CRLF line ends, `Date` at `at`, and any
 * `headers` of its own. Its attachments are parts of their own (`multipart/mixed`), one with a
 * `Content-ID` inline beside the HTML that names it (`multipart/related`).
 */
export function composeMime(
  message: MimeMessage & { readonly attachments?: readonly EmailAttachment[] },
  at: number,
  headers: Readonly<Record<string, string>> = {},
): Promise<string> {
  const composer = new MailComposer({
    from: formatMailbox(message.from),
    to: message.to.map(formatMailbox),
    ...(message.cc.length > 0 ? { cc: message.cc.map(formatMailbox) } : {}),
    ...(message.replyTo.length > 0 ? { replyTo: message.replyTo.map(formatMailbox) } : {}),
    subject: message.subject,
    ...(message.text === undefined ? {} : { text: message.text }),
    ...(message.html === undefined ? {} : { html: message.html }),
    messageId: message.messageId,
    ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
    ...(message.references.length > 0 ? { references: [...message.references] } : {}),
    // The composer writes no Bcc header: who got a blind copy is the sender's to know.
    date: new Date(at),
    headers: { ...headers },
    attachments: (message.attachments ?? []).map((attachment) => {
      if (attachment.content === undefined) throw new Error(`${attachment.filename} has no content to send`);
      return {
        filename: attachment.filename,
        content: Buffer.from(attachment.content),
        contentType: attachment.contentType,
        ...(attachment.contentId === undefined
          ? { contentDisposition: "attachment" as const }
          : { cid: attachment.contentId, contentDisposition: "inline" as const }),
      };
    }),
  });
  return new Promise((resolve, reject) => {
    composer.compile().build((error, bytes) => (error ? reject(error) : resolve(bytes.toString("utf8"))));
  });
}

/** The top-level headers of a message, in order, each unfolded and its encoded words decoded (`=?UTF-8?Q?…?=`). */
export function mimeHeaders(raw: string): MimeHeader[] {
  const end = raw.search(/\r?\n\r?\n/);
  const head = (end < 0 ? raw : raw.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  return head.split(/\r?\n/).flatMap((line) => {
    const colon = line.indexOf(":");
    return colon <= 0 ? [] : [{ name: line.slice(0, colon), value: decodeWords(line.slice(colon + 1).trim()) }];
  });
}

/**
 * The mailboxes of an address field as `postal-mime` read it: parsed before their names were
 * decoded (a comma in `=?UTF-8?Q?Lima=2C_Ana?=` is a name's), groups flattened, an entry with no
 * address left out.
 */
function mailboxesOf(field: Address | readonly Address[] | undefined): Mailbox[] {
  const entries: readonly Address[] = field === undefined ? [] : Array.isArray(field) ? field : [field as Address];
  return entries
    .flatMap((entry) => entry.group ?? [entry])
    .flatMap((mailbox) =>
      typeof mailbox.address === "string" && mailbox.address.includes("@")
        ? [{ address: mailbox.address.toLowerCase(), name: mailbox.name ?? "" }]
        : [],
    );
}

/**
 * A message with these headers set, as a mail server stamps what it sends (Gmail's own
 * `Message-ID`, its `From`): each replaces the field of its name, folded lines and all, and the
 * new fields come first. The body is untouched.
 */
export function withHeaders(raw: string, headers: Readonly<Record<string, string>>): string {
  const end = raw.search(/\r?\n\r?\n/);
  const head = end < 0 ? raw : raw.slice(0, end);
  const eol = head.includes("\r\n") ? "\r\n" : "\n";
  const fields: string[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && fields.length > 0) fields[fields.length - 1] += `${eol}${line}`;
    else fields.push(line);
  }
  const named = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  const kept = fields.filter((field) => !named.has(field.slice(0, field.indexOf(":")).trim().toLowerCase()));
  const set = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return [...set, ...kept].join(eol) + (end < 0 ? "" : raw.slice(end));
}

/** Read a message someone sent: who it is from and to, what it says, and what it answers. */
export async function parseMime(raw: string): Promise<MimeMessage & { readonly headers: MimeHeader[] }> {
  const parsed = await PostalMime.parse(raw);
  const headers = mimeHeaders(raw);
  const header = (name: string) => headers.find((each) => each.name.toLowerCase() === name)?.value;
  const [from] = mailboxesOf(parsed.from);
  return {
    from: from ?? { address: "", name: "" },
    to: mailboxesOf(parsed.to),
    cc: mailboxesOf(parsed.cc),
    bcc: mailboxesOf(parsed.bcc),
    replyTo: mailboxesOf(parsed.replyTo),
    subject: parsed.subject ?? "",
    text: parsed.text ?? undefined,
    html: parsed.html ?? undefined,
    messageId: messageIdsIn(header("message-id"))[0] ?? "",
    inReplyTo: messageIdsIn(header("in-reply-to"))[0],
    references: messageIdsIn(header("references")),
    headers,
  };
}
