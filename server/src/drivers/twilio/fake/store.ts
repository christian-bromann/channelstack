import type { Collection, Registry } from "../../../core/registry/index.ts";
import type { TwilioAppRecord, TwilioConversationRecord, TwilioMessageRecord, TwilioPersonRecord } from "../world.ts";

/** Two numbers in the order a conversation keeps them. */
const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/**
 * The Twilio driver's in-memory state, for the fake and for live mode's mirror: the agent's
 * account, people's phones, every message, and the conversations between two numbers.
 */
export class TwilioStore {
  readonly users: Collection<TwilioPersonRecord>;
  readonly messages: Collection<TwilioMessageRecord>;
  readonly conversations: Collection<TwilioConversationRecord>;
  /** The people who texted `STOP` to the agent's number: Twilio sends them nothing from it until `START`. */
  readonly optedOut = new Set<string>();
  #app: TwilioAppRecord | undefined;

  constructor(registry: Registry) {
    this.users = registry.collection("twilio", "user");
    this.messages = registry.collection("twilio", "message");
    this.conversations = registry.collection("twilio", "conversation");
  }

  /** The agent's account and number. It belongs to no session. */
  get app(): TwilioAppRecord {
    if (!this.#app) throw new Error("The fake hasn't been seeded");
    return this.#app;
  }

  seed(app: TwilioAppRecord): void {
    this.#app = app;
    this.optedOut.clear();
  }

  /** The person with this number, in any session. */
  personAt(number: string): TwilioPersonRecord | undefined {
    return this.users.find(number);
  }

  /** The conversation between two numbers, in any session. */
  conversationOf(a: string, b: string): TwilioConversationRecord | undefined {
    const [first, second] = pair(a, b);
    return this.conversations.values().find(({ numbers }) => numbers[0] === first && numbers[1] === second);
  }

  /**
   * The conversation a message between two numbers joins, or the one it starts (its id is the
   * message's), owned by `session`.
   */
  conversationFor(from: string, to: string, first: string, at: number, session: string | undefined): string {
    const existing = this.conversationOf(from, to);
    if (existing) return existing.id;
    return this.conversations.add(first, { id: first, numbers: pair(from, to), createdAt: at }, session).id;
  }

  /** A conversation's messages, oldest first. */
  messagesIn(conversation: string): TwilioMessageRecord[] {
    return this.messages
      .values()
      .filter((message) => message.conversation === conversation)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** What reached a number, oldest first. */
  messagesTo(number: string): TwilioMessageRecord[] {
    return this.messages
      .values()
      .filter((message) => message.to === number && message.status !== "undelivered" && message.status !== "failed")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Keep a message, in its conversation's session. */
  keep(message: TwilioMessageRecord, session: string | undefined): TwilioMessageRecord {
    return this.messages.add(message.id, message, session ?? this.conversations.owner(message.conversation));
  }
}
