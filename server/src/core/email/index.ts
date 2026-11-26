import { compile } from "html-to-text";
import { addressParser } from "postal-mime";

import { type TranscriptEntry, type TranscriptPrincipal, transcriptText } from "../router/inspect.ts";

/**
 * What every email channel shares (Resend, Gmail): addresses, `Message-ID`s, threading by
 * `In-Reply-To` and `References`, and an email thread as a person reads it. Drivers can't import
 * each other, so it lives here.
 */

/** An address and the name it is shown with: `Ana Lima <ana@example.com>`. */
export interface Mailbox {
  readonly address: string;
  readonly name: string;
}

/** A file an email carries, by the platform's id for it. */
export interface EmailAttachment {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  /** Its size in bytes. */
  readonly size: number;
  /** Its bytes. Undefined for one a live world read back without downloading it. */
  readonly content: Uint8Array | undefined;
  /** The `Content-ID` an HTML body names it by (`cid:logo`): shown inline, not as a file. */
  readonly contentId: string | undefined;
}

/**
 * The mailboxes in an address field: one address or a list, each `addr` or `Name <addr>`. Group
 * syntax is flattened, as mail clients show it. An entry with no address in it is left out.
 */
export function parseAddresses(field: string | readonly string[] | undefined): Mailbox[] {
  if (field === undefined) return [];
  const entries = typeof field === "string" ? [field] : field;
  return entries.flatMap((entry) =>
    addressParser(entry, { flatten: true }).flatMap((parsed) =>
      "address" in parsed && typeof parsed.address === "string" && parsed.address.includes("@")
        ? [{ address: parsed.address.toLowerCase(), name: parsed.name ?? "" }]
        : [],
    ),
  );
}

/** A mailbox as an address field writes it: `Ana Lima <ana@example.com>`, or the bare address. */
export function formatMailbox(mailbox: Mailbox): string {
  if (mailbox.name === "") return mailbox.address;
  const name = /[",<>@;:\\]/.test(mailbox.name) ? JSON.stringify(mailbox.name) : mailbox.name;
  return `${name} <${mailbox.address}>`;
}

/** The domain an address is at: `example.com`. */
export const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** The local part a person's address gets from their name: `Ana María` → `ana.mar.a`, `person` if nothing is left. */
export const localPartOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "") || "person";

/** A `Message-ID`, made at the sending domain the way mail servers make them: `<random@domain>`. */
export const messageId = (local: string, domain: string): string => `<${local}@${domain}>`;

/** Message ids in a header (`References` holds several, `In-Reply-To` one), angle brackets kept. */
export function messageIdsIn(header: string | undefined): string[] {
  return header?.match(/<[^<>\s]+>/g) ?? [];
}

/** The subject of a reply: `Re: ` before the original's, unless it has one already. */
const replySubject = (subject: string): string => (/^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`);

/**
 * The headers a reply carries, as RFC 5322 says: `In-Reply-To` is the message answered, and
 * `References` that message's references with its id added.
 */
function replyHeaders(to: { messageId: string; references: readonly string[] }): {
  inReplyTo: string;
  references: string[];
} {
  return { inReplyTo: to.messageId, references: [...to.references.filter((id) => id !== to.messageId), to.messageId] };
}

/** What a reply needs of the email it answers. */
export interface Answerable {
  readonly from: Mailbox;
  readonly to: readonly Mailbox[];
  readonly cc: readonly Mailbox[];
  readonly replyTo: readonly Mailbox[];
  readonly subject: string;
  readonly messageId: string;
  readonly references: readonly string[];
}

/**
 * A person's reply to an email: to its sender (its `Reply-To` if it has one), and with `all` to
 * everyone else on it too; `Re:` its subject, `In-Reply-To` and `References` set.
 */
export function replyOf(person: { readonly address: string }, to: Answerable, all: boolean) {
  const sender: readonly Mailbox[] = to.replyTo.length > 0 ? to.replyTo : [to.from];
  const others = all
    ? [...to.to, ...to.cc].filter(
        (mailbox) => mailbox.address !== person.address && !sender.some((s) => s.address === mailbox.address),
      )
    : [];
  return {
    to: sender,
    cc: others,
    subject: replySubject(to.subject),
    ...replyHeaders({ messageId: to.messageId, references: to.references }),
  };
}

/**
 * Who wrote an email, as a transcript names them: the app, a person (by `person`, from the author's
 * id), or for an address no one in the world has, the address itself.
 */
export function emailAuthor(
  email: { readonly author: string | undefined; readonly from: Mailbox },
  app: { readonly id: string; readonly name: string },
  person: (id: string) => { readonly id: string; readonly name: string } | undefined,
): TranscriptPrincipal {
  if (email.author === app.id) return { id: app.id, name: app.name, kind: "app" };
  const found = email.author === undefined ? undefined : person(email.author);
  if (found) return { id: found.id, name: found.name, kind: "user" };
  return { id: email.from.address, name: email.from.name || email.from.address, kind: "user" };
}

/**
 * Which thread a message belongs to, the way mail clients thread: the thread of any message it
 * names in `In-Reply-To` or `References`, newest reference first. Undefined: it starts a thread.
 */
export function threadOf(
  message: { inReplyTo?: string | undefined; references: readonly string[] },
  threadOfMessage: (messageId: string) => string | undefined,
): string | undefined {
  const named = [...(message.inReplyTo ? [message.inReplyTo] : []), ...[...message.references].reverse()];
  for (const id of named) {
    const thread = threadOfMessage(id);
    if (thread !== undefined) return thread;
  }
  return undefined;
}

/**
 * The text a person reads of a message: what they wrote, without the quoted history a reply carries
 * (`> …` lines, and the `On …, … wrote:` line that introduces them), trimmed.
 */
function ownText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? "";
    if (line.startsWith(">")) continue;
    // Gmail, Apple Mail and Outlook introduce a quote with one line; the quote follows it, after a
    // blank line in HTML mail, where the line and the quote are blocks of their own.
    if (
      /^On .+ wrote:\s*$/.test(line) &&
      (lines.slice(at + 1).find((next) => next.trim() !== "") ?? "").startsWith(">")
    )
      continue;
    kept.push(line);
  }
  // The blank lines around a dropped quote fold into one, as between paragraphs.
  return kept
    .join("\n")
    .replace(/\n\s*\n(\s*\n)+/g, "\n\n")
    .trim();
}

/** A line break before and after: a table's rows and cells, which mail lays out with, read as lines. */
const LINE = { leadingLineBreaks: 1, trailingLineBreaks: 1 };

/**
 * HTML as a person reads it, on `html-to-text`: entities decoded (a no-break space is a space),
 * blocks, line breaks and a layout table's rows and cells as lines, `ul` items as `- ` and `ol`
 * items as ` 1. ` (the library's prefix, its space included), a quote as `> ` lines (so `ownText`
 * drops it as it does in text mail), an image as its alt text, no scripts or styles, and lines as
 * long as they were written. With `links`, a link reads as its text and its address (the address
 * once, when it is the text); without, as its text. A link with no text at all (an image with no
 * alt text in it, say) reads as its address, as the library writes it, or with no addresses, as nothing.
 */
const converter = (links: boolean) =>
  compile({
    wordwrap: false,
    whitespaceCharacters: " \t\r\n\f\u200b\u00a0",
    formatters: {
      altText: (elem, _walk, builder) => {
        const alt: unknown = elem.attribs?.alt;
        if (typeof alt === "string" && alt.trim() !== "") builder.addInline(alt);
      },
    },
    selectors: [
      { selector: "a", options: links ? { hideLinkHrefIfSameAsText: true } : { ignoreHref: true } },
      { selector: "img", format: "altText" },
      { selector: "ul", options: { itemPrefix: "- " } },
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({ selector, options: { uppercase: false } })),
      ...["tr", "td", "th"].map((selector) => ({ selector, format: "block", options: LINE })),
    ],
  });
const withLinks = converter(true);
const withoutLinks = converter(false);

/**
 * The plain text of an HTML body, as a person reads it: for an email sent with HTML only, in a
 * transcript (with link addresses) or in Gmail's snippet (without).
 */
export function htmlToText(html: string, options: { readonly links: boolean }): string {
  return (options.links ? withLinks : withoutLinks)(html)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One message of a thread, as the transcript needs it. */
export interface ThreadMessage {
  readonly id: string;
  readonly author: TranscriptPrincipal;
  readonly at: string;
  readonly text: string | undefined;
  readonly html: string | undefined;
  readonly attachments: readonly string[];
}

/**
 * An email thread as a person reads it: each message's own words (an HTML-only one as its text),
 * with the names of its attachments. Every message is at the top level: email has no nesting.
 */
export function threadTranscript(messages: readonly ThreadMessage[]): { entries: TranscriptEntry[]; text: string } {
  const entries: TranscriptEntry[] = messages.map((message) => {
    const body = ownText(message.text ?? htmlToText(message.html ?? "", { links: true }));
    const attached = message.attachments.length === 0 ? "" : `\n(attached: ${message.attachments.join(", ")})`;
    return {
      id: message.id,
      author: message.author,
      at: message.at,
      text: `${body}${attached}`,
      controls: [],
      edited: false,
      depth: 0,
    };
  });
  return { entries, text: transcriptText(entries) };
}
