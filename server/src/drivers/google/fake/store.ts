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
 * One app's Gmail mailbox beyond its mail: its labels, its watch and its history id. They belong
 * to no session, and outlive a reset: the app's agent runs on.
 */
export class GmailMailbox {
  readonly labels = new Map<string, GmailLabelRecord>();
  watch: GmailWatchRecord | undefined;
  /** Where the mailbox's history starts: a `startHistoryId` before it is too old. */
  historyStart = "0";
  /** The mailbox's newest history id. */
  historyId = "0";
  /** How many labels the app has made: a label's id is never given out twice, a reset or not. */
  #userLabels = 0;

  /**
   * The mailbox as a reset leaves it: Gmail's labels. What the app set up stays: its watch, and the
   * labels it made. The history id never goes back (Gmail's only grow): a cursor the agent kept
   * lists what comes after the reset.
   */
  seed(historyStart: string): void {
    for (const label of SYSTEM_LABELS) this.labels.set(label.id, label);
    this.historyStart = historyStart;
    if (BigInt(this.historyId) < BigInt(historyStart)) this.historyId = historyStart;
  }

  /** The id of a label the app makes: `Label_<n>`, counting every one it has made. */
  nextLabelId(): string {
    this.#userLabels += 1;
    return `Label_${this.#userLabels}`;
  }
}

/**
 * The Google fake's in-memory state: the email core's, and each app's Gmail mailbox. Their
 * messages, threads and history belong to the sessions whose email is in them, each to one mailbox.
 */
export class GoogleStore extends EmailStore<GoogleEmailRecord, GoogleAppRecord> {
  readonly messages: Collection<GmailMessageRecord>;
  readonly gmailThreads: Collection<GmailThreadRecord>;
  /** Keyed by mailbox and history id: two mailboxes count their history apart. */
  readonly history: Collection<GmailHistoryRecord>;
  /** Each app's mailbox, by its name. */
  readonly #mailboxes = new Map<string, GmailMailbox>();

  constructor(registry: Registry) {
    super(registry, "google", "Google");
    this.messages = registry.collection("google", "message");
    this.gmailThreads = registry.collection("google", "gmail thread");
    this.history = registry.collection("google", "history");
  }

  /** The built-in mailbox as a reset leaves it, its history starting at `historyStart`. */
  seed(app: GoogleAppRecord, historyStart: string): void {
    this.setApp(app);
    this.mailbox(app.name, historyStart);
  }

  /** An app's mailbox; made, its history starting at `historyStart`, the first time; seeded again when that is given. */
  mailbox(app: string, historyStart?: string): GmailMailbox {
    let mailbox = this.#mailboxes.get(app);
    if (!mailbox) {
      mailbox = new GmailMailbox();
      this.#mailboxes.set(app, mailbox);
      mailbox.seed(historyStart ?? "0");
    } else if (historyStart !== undefined) mailbox.seed(historyStart);
    return mailbox;
  }

  /** The messages of one app's mailbox. */
  messagesOf(app: string): GmailMessageRecord[] {
    return this.messages.values().filter((message) => message.mailbox === app);
  }

  /** A thread's messages, oldest first. */
  messagesIn(threadId: string): GmailMessageRecord[] {
    return this.messages
      .values()
      .filter((message) => message.threadId === threadId)
      .sort((a, b) => a.internalDate - b.internalDate);
  }
}
