import type { Collection, Registry } from "../../../core/registry/index.ts";
import type {
  GmailHistoryRecord,
  GmailLabelRecord,
  GmailMessageRecord,
  GmailThreadRecord,
  GmailWatchRecord,
  GoogleAppRecord,
  GoogleEmailRecord,
  GoogleThreadRecord,
  GoogleUserRecord,
} from "../world.ts";

/** Gmail's own labels, as every mailbox has them. */
export const SYSTEM_LABELS: readonly GmailLabelRecord[] = [
  "CHAT",
  "SENT",
  "INBOX",
  "IMPORTANT",
  "TRASH",
  "DRAFT",
  "SPAM",
  "CATEGORY_FORUMS",
  "CATEGORY_UPDATES",
  "CATEGORY_PERSONAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "STARRED",
  "UNREAD",
].map((id) => ({
  id,
  name: id,
  type: "system" as const,
  // Gmail lists its folders and hides its states and categories.
  ...(["SENT", "INBOX", "TRASH", "DRAFT", "SPAM", "STARRED", "IMPORTANT", "CHAT"].includes(id)
    ? { messageListVisibility: "hide" as const, labelListVisibility: "labelShow" as const }
    : {}),
}));

/**
 * The Google fake's in-memory state. Objects live in the core registry; the store adds Gmail's
 * lookups. The agent's mailbox (its messages, threads, history) belongs to the sessions whose
 * email is in it; its labels and its watch belong to no session.
 */
export class GoogleStore {
  readonly users: Collection<GoogleUserRecord>;
  readonly emails: Collection<GoogleEmailRecord>;
  readonly threads: Collection<GoogleThreadRecord>;
  readonly messages: Collection<GmailMessageRecord>;
  readonly gmailThreads: Collection<GmailThreadRecord>;
  readonly history: Collection<GmailHistoryRecord>;
  readonly labels = new Map<string, GmailLabelRecord>();
  watch: GmailWatchRecord | undefined;
  /** Where the mailbox's history starts: a `startHistoryId` before it is too old. */
  historyStart = "0";
  /** The mailbox's newest history id. */
  historyId = "0";
  #app: GoogleAppRecord | undefined;

  constructor(registry: Registry) {
    this.users = registry.collection("google", "user");
    this.emails = registry.collection("google", "email");
    this.threads = registry.collection("google", "thread");
    this.messages = registry.collection("google", "message");
    this.gmailThreads = registry.collection("google", "gmail thread");
    this.history = registry.collection("google", "history");
  }

  /** The agent's mailbox. It belongs to no session. */
  get app(): GoogleAppRecord {
    if (!this.#app) throw new Error("The Google fake hasn't been seeded");
    return this.#app;
  }

  seed(app: GoogleAppRecord, historyStart: string): void {
    this.#app = app;
    this.labels.clear();
    for (const label of SYSTEM_LABELS) this.labels.set(label.id, label);
    this.watch = undefined;
    this.historyStart = historyStart;
    this.historyId = historyStart;
  }

  /** The person with this address, in any session. */
  personAt(address: string): GoogleUserRecord | undefined {
    const wanted = address.toLowerCase();
    return this.users.values().find((user) => user.address === wanted);
  }

  /** The email with this `Message-ID`, in any session. */
  byMessageId(messageId: string): GoogleEmailRecord | undefined {
    return this.emails.values().find((email) => email.messageId === messageId);
  }

  /** A conversation's emails, oldest first. */
  emailsIn(thread: string): GoogleEmailRecord[] {
    return this.emails
      .values()
      .filter((email) => email.thread === thread)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** What reached an address: every email it is a recipient of, oldest first. */
  mailTo(address: string): GoogleEmailRecord[] {
    return this.emails
      .values()
      .filter((email) => [...email.to, ...email.cc, ...email.bcc].some((mailbox) => mailbox.address === address))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** A thread's messages in the agent's mailbox, oldest first. */
  messagesIn(threadId: string): GmailMessageRecord[] {
    return this.messages
      .values()
      .filter((message) => message.threadId === threadId)
      .sort((a, b) => a.internalDate - b.internalDate);
  }
}
