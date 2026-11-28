import type { MimeHeader } from "../../core/email/mime.ts";
import type { EmailAppRecord, EmailPersonRecord, EmailRecord } from "../../core/email/store.ts";

/**
 * The Google fake's records. The Gmail API shows each app its own mailbox only: the copies of
 * email that reached it or that it sent, in its own threads, with its labels and its history. The
 * people's mail beyond that is the outside world's, which the fake keeps too, so a person's inbox
 * can be read.
 */

/**
 * An app's mailbox: the agent's (`my-agent`), or another app's (decision 0027), each a Workspace
 * address of its own with its own OAuth client. Its id is its Google account's.
 */
export type GoogleAppRecord = EmailAppRecord;

/** A person: a mailbox in the outside world. */
export type GoogleUserRecord = EmailPersonRecord;

/** One email as it was sent, whoever sent it. Its id is its sender's copy's. */
export interface GoogleEmailRecord extends EmailRecord {
  /** The message as it travelled (RFC 5322), and its top-level headers. Live, what was read back. */
  readonly raw: string | undefined;
  readonly headers: readonly MimeHeader[];
  /** The agent's copy of it, in its mailbox, if it has one. */
  agentCopy: string | undefined;
}

/** A message in an app's mailbox: its copy of an email, in one of its threads, with its labels. */
export interface GmailMessageRecord {
  readonly id: string;
  /** The mailbox it is in, by its app's name. */
  readonly mailbox: string;
  /** The email it is a copy of. */
  readonly email: string;
  readonly threadId: string;
  labels: string[];
  /** The history id of its last change. */
  historyId: string;
  readonly internalDate: number;
}

/** A thread in an app's mailbox, as Gmail threads: by references and a matching subject. */
export interface GmailThreadRecord {
  readonly id: string;
  readonly mailbox: string;
  /** Its subject without `Re:` and `Fwd:`, which a message joining it must match. */
  readonly subject: string;
}

/** A label of the agent's mailbox: Gmail's own (`INBOX`), or one it made (`Label_1`). */
export interface GmailLabelRecord {
  readonly id: string;
  readonly name: string;
  readonly type: "system" | "user";
  readonly messageListVisibility?: "show" | "hide";
  readonly labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide";
}

/** One change to an app's mailbox, as `users.history.list` lists them. */
export interface GmailHistoryRecord {
  readonly id: string;
  readonly mailbox: string;
  readonly kind: "messageAdded" | "labelAdded" | "labelRemoved" | "messageDeleted";
  readonly message: string;
  readonly threadId: string;
  /** The labels added or removed. */
  readonly labels: readonly string[];
  /** The message's labels just after the change. */
  readonly labelsAfter: readonly string[];
}

/** The agent's `users.watch`: which topic, and which labels' changes are pushed. */
export interface GmailWatchRecord {
  readonly topicName: string;
  readonly labelIds: readonly string[];
  readonly behavior: "include" | "exclude";
  readonly expiration: number;
}
