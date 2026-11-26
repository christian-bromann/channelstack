import MailComposer from "nodemailer/lib/mail-composer/index.js";
import PostalMime, { decodeWords } from "postal-mime";

import { formatMailbox, type Mailbox, messageIdsIn, parseAddresses } from "./index.ts";

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

/** Build a message: the bytes a mail server would send, CRLF line ends, `Date` at `at`. */
export function composeMime(message: MimeMessage, at: number): Promise<string> {
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

/** Read a message someone sent: who it is from and to, what it says, and what it answers. */
export async function parseMime(raw: string): Promise<MimeMessage & { readonly headers: MimeHeader[] }> {
  const parsed = await PostalMime.parse(raw);
  const headers = mimeHeaders(raw);
  const header = (name: string) => headers.find((each) => each.name.toLowerCase() === name)?.value;
  const mailboxes = (name: string) => parseAddresses(header(name) ? [header(name) as string] : undefined);
  const [from] = mailboxes("from");
  return {
    from: from ?? { address: "", name: "" },
    to: mailboxes("to"),
    cc: mailboxes("cc"),
    bcc: mailboxes("bcc"),
    replyTo: mailboxes("reply-to"),
    subject: parsed.subject ?? "",
    text: parsed.text ?? undefined,
    html: parsed.html ?? undefined,
    messageId: messageIdsIn(header("message-id"))[0] ?? "",
    inReplyTo: messageIdsIn(header("in-reply-to"))[0],
    references: messageIdsIn(header("references")),
    headers,
  };
}
