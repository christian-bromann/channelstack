import type { Mailbox } from "../../core/email/index.ts";

/**
 * The Resend fake's records. Resend sees only the mail of the agent's team: what it sends, and
 * what reaches its receiving domain. The people's mail beyond that is the outside world's, which
 * the fake keeps too, so a person's inbox can be read.
 */

/** The agent's team: its domain (sending and receiving), and its webhook. */
export interface ResendAppRecord {
  readonly id: string;
  readonly name: string;
  /** Where people email the agent: `my-agent@<domain>`. */
  readonly address: string;
  readonly domain: string;
  readonly domainId: string;
  readonly webhookId: string;
  /** The events the webhook is subscribed to. */
  readonly events: readonly string[];
}

/** A person: a mailbox in the outside world. */
export interface ResendUserRecord {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  /** The test chose the id: freed again when its session closes (decision 0006). */
  readonly fixedId: boolean;
}

/** What happened to an email the app sent last, as `last_event` says. */
export type ResendLastEvent = "sent" | "delivered" | "bounced" | "complained" | "suppressed" | "delivery_delayed";

export interface ResendEmailRecord {
  /** Resend's id: of the email the team sent, or of the one it received. */
  readonly id: string;
  /** `received` by the team, `sent` by it, or mail between people Resend never sees (`outside`). */
  readonly direction: "received" | "sent" | "outside";
  /** Who wrote it: a person's or the app's id, or none for an address no one in the world has. */
  readonly author: string | undefined;
  readonly from: Mailbox;
  readonly to: readonly Mailbox[];
  readonly cc: readonly Mailbox[];
  readonly bcc: readonly Mailbox[];
  readonly replyTo: readonly Mailbox[];
  readonly subject: string;
  readonly text: string | undefined;
  readonly html: string | undefined;
  /** Headers the sender set itself, beyond the ones every email has. */
  readonly headers: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
  readonly messageId: string;
  readonly inReplyTo: string | undefined;
  readonly references: readonly string[];
  /** The thread it is in: the id of the thread's first email. */
  readonly thread: string;
  readonly createdAt: number;
  lastEvent: ResendLastEvent | undefined;
  /** For a received email: the `email.received` delivery that told the agent. */
  delivery: string | undefined;
}

/** A thread: emails joined by `In-Reply-To` and `References`. Its id is its first email's. */
export interface ResendThreadRecord {
  readonly id: string;
  readonly subject: string;
  readonly createdAt: number;
}
