import { EmailStore } from "../../../core/email/store.ts";
import type { Collection, Registry } from "../../../core/registry/index.ts";
import type {
  GmailHistoryRecord,
  GmailLabelRecord,
  GmailMessageRecord,
  GmailThreadRecord,
  GmailWatchRecord,
  GoogleAppRecord,
  GoogleEmailRecord,
} from "../world.ts";

/** Gmail's own labels, as every mailbox has them. */
const SYSTEM_LABELS: readonly GmailLabelRecord[] = [
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
 * The Google fake's in-memory state: the email core's, and the agent's Gmail mailbox. Its messages,
 * threads and history belong to the sessions whose email is in them; its labels and its watch
 * belong to no session.
 */
export class GoogleStore extends EmailStore<GoogleEmailRecord, GoogleAppRecord> {
  readonly messages: Collection<GmailMessageRecord>;
  readonly gmailThreads: Collection<GmailThreadRecord>;
  readonly history: Collection<GmailHistoryRecord>;
  readonly labels = new Map<string, GmailLabelRecord>();
  watch: GmailWatchRecord | undefined;
  /** Where the mailbox's history starts: a `startHistoryId` before it is too old. */
  historyStart = "0";
  /** The mailbox's newest history id. */
  historyId = "0";
  /** How many labels the agent has made: a label's id is never given out twice, a reset or not. */
  #userLabels = 0;

  constructor(registry: Registry) {
    super(registry, "google");
    this.messages = registry.collection("google", "message");
    this.gmailThreads = registry.collection("google", "gmail thread");
    this.history = registry.collection("google", "history");
  }

  /**
   * The mailbox as a reset leaves it: no mail. The agent runs on, so what it set up stays: its
   * watch, and the labels it made. The history id never goes back (Gmail's only grow): a cursor the
   * agent kept lists what comes after the reset.
   */
  seed(app: GoogleAppRecord, historyStart: string): void {
    this.setApp(app);
    for (const label of SYSTEM_LABELS) this.labels.set(label.id, label);
    this.historyStart = historyStart;
    if (BigInt(this.historyId) < BigInt(historyStart)) this.historyId = historyStart;
  }

  /** The id of a label the agent makes: `Label_<n>`, counting every one it has made. */
  nextLabelId(): string {
    this.#userLabels += 1;
    return `Label_${this.#userLabels}`;
  }

  /** A thread's messages in the agent's mailbox, oldest first. */
  messagesIn(threadId: string): GmailMessageRecord[] {
    return this.messages
      .values()
      .filter((message) => message.threadId === threadId)
      .sort((a, b) => a.internalDate - b.internalDate);
  }
}
