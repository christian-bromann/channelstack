import type { EmailAppRecord, EmailPersonRecord, EmailRecord } from "../../core/email/store.ts";

/**
 * The Resend fake's records. Resend sees only the mail of its teams: what each sends, and what
 * reaches its receiving domain. The people's mail beyond that is the outside world's, which the
 * fake keeps too, so a person's inbox can be read.
 */

/**
 * A team: the agent's (`my-agent`), or another app's (decision 0027), each with its own API key,
 * domain (sending and receiving), address and webhook. A domain belongs to one team.
 */
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
  /**
   * `received` by a team from a person, `sent` by a team (and received by any other it reaches), or
   * mail between people Resend never sees (`outside`).
   */
  readonly direction: "received" | "sent" | "outside";
  /** The team that sent it through the API, by its app's name: for a `sent` email. */
  readonly team: string | undefined;
  /** Headers the sender set itself, beyond the ones every email has. */
  readonly headers: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
  /** The message as a team received it (RFC 5322), for an email to a team: what `raw.download_url` opens. */
  readonly raw: string | undefined;
  lastEvent: ResendLastEvent | undefined;
}
