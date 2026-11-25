/**
 * What every email channel's people write (Resend, Google): an email, and a reply in its thread.
 * Each channel's people take these with their own handles as recipients.
 */

/** An email a person sends: who it goes to, its subject, and its body (text, HTML, or both). */
export interface EmailSendOptions<TRecipient> {
  /** Who it goes to: the agent's app, other people. */
  to: readonly TRecipient[];
  /** Who gets a copy. */
  cc?: readonly TRecipient[];
  subject: string;
  /** The plain-text body. An email needs `text`, `html`, or both. */
  text?: string;
  html?: string;
}

/** A reply: in the email's thread, `Re:` its subject, with `In-Reply-To` and `References` set. */
export interface EmailReplyOptions {
  text?: string;
  html?: string;
  /** Reply to everyone on the email, not only its sender. Default false. */
  all?: boolean;
}
