import type { Mailbox } from "../../core/email/index.ts";
import type { MimeHeader } from "../../core/email/mime.ts";

/**
 * The Google fake's records. The Gmail API shows the agent its own mailbox only: the copies of
 * email that reached it or that it sent, in its own threads, with its labels and its history. The
 * people's mail beyond that is the outside world's, which the fake keeps too, so a person's inbox
 * can be read.
 */

/** The agent's mailbox. */
export interface GoogleAppRecord {
  /** The mailbox's Google account id. */
  readonly id: string;
  readonly name: string;
  /** Where people email the agent. */
  readonly address: string;
}

/** A person: a mailbox in the outside world. */
export interface GoogleUserRecord {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  /** The test chose the id: freed again when its session closes (decision 0006). */
  readonly fixedId: boolean;
}

/** One email as it was sent, whoever sent it. */
export interface GoogleEmailRecord {
  /** The email's id: the id of its sender's copy. */
  readonly id: string;
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
  readonly messageId: string;
  readonly inReplyTo: string | undefined;
  readonly references: readonly string[];
  /** The conversation it is in, as a test reads it: the id of its first email. */
  readonly thread: string;
  readonly createdAt: number;
  /** The message as it travelled (RFC 5322), and its top-level headers. Live, what was read back. */
  readonly raw: string | undefined;
  readonly headers: readonly MimeHeader[];
  /** The agent's copy of it, in its mailbox, if it has one. */
  agentCopy: string | undefined;
  /** For an email to the agent: the push that told it of its copy. */
  delivery: string | undefined;
}

/** A conversation: emails joined by `In-Reply-To` and `References`. Its id is its first email's. */
export interface GoogleThreadRecord {
  readonly id: string;
  readonly subject: string;
  readonly createdAt: number;
}

/** A message in the agent's mailbox: its copy of an email, in one of its threads, with its labels. */
export interface GmailMessageRecord {
  readonly id: string;
  /** The email it is a copy of. */
  readonly email: string;
  readonly threadId: string;
  labels: string[];
  /** The history id of its last change. */
  historyId: string;
  readonly internalDate: number;
}

/** A thread in the agent's mailbox, as Gmail threads: by references and a matching subject. */
export interface GmailThreadRecord {
  readonly id: string;
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

/** One change to the agent's mailbox, as `users.history.list` lists them. */
export interface GmailHistoryRecord {
  readonly id: string;
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
