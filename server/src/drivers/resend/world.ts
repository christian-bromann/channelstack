import type { EmailAppRecord, EmailPersonRecord, EmailRecord } from "../../core/email/store.ts";

/**
 * The Resend fake's records. Resend sees only the mail of the agent's team: what it sends, and
 * what reaches its receiving domain. The people's mail beyond that is the outside world's, which
 * the fake keeps too, so a person's inbox can be read.
 */

/** The agent's team: its domain (sending and receiving), and its webhook. */
export interface ResendAppRecord extends EmailAppRecord {
  readonly domain: string;
  readonly domainId: string;
  readonly webhookId: string;
  /** The events the webhook is subscribed to. */
  readonly events: readonly string[];
}

/** A person: a mailbox in the outside world. */
export type ResendUserRecord = EmailPersonRecord;

/** What happened to an email the app sent last, as `last_event` says. */
export type ResendLastEvent = "sent" | "delivered" | "bounced" | "complained" | "suppressed" | "delivery_delayed";

export interface ResendEmailRecord extends EmailRecord {
  /** `received` by the team, `sent` by it, or mail between people Resend never sees (`outside`). */
  readonly direction: "received" | "sent" | "outside";
  /** Headers the sender set itself, beyond the ones every email has. */
  readonly headers: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
  lastEvent: ResendLastEvent | undefined;
}
