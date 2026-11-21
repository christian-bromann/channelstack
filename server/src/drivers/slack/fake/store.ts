import type { Collection, Registry } from "../../../core/registry/index.ts";
import type {
  SlackAppRecord,
  SlackConversationRecord,
  SlackFileRecord,
  SlackMessageRecord,
  SlackTeam,
  SlackThreadState,
  SlackUserRecord,
  SlackViewRecord,
} from "../world.ts";

/** A transport fault for the agent's Web API calls (`slack.fault(...)`). */
export interface SlackFault {
  readonly id: string;
  readonly session: string;
  readonly type: "rate_limit" | "latency" | "error";
  /** Only calls to this method; every method when left out. */
  readonly operation: string | undefined;
  /** How many more calls it applies to; forever when left out. */
  remaining: number | undefined;
  readonly retryAfterMs: number;
  readonly delayMs: number;
  readonly error: string;
}

/** A `response_url`: where the app answers one interaction, a few times, for a while. */
export interface SlackResponseUrl {
  readonly session: string;
  readonly conversation: string;
  /** Who acted: an answer that isn't `in_channel` is for them alone. */
  readonly user: string;
  /** The message the control was on, which an answer replaces by default. A command or a shortcut has none. */
  readonly source: string | undefined;
  readonly threadTs: string | undefined;
  readonly expiresAt: number;
  uses: number;
}

/** The Slack fake's in-memory state. Objects live in the core registry; the store adds Slack's own indexes. */
export class SlackStore {
  readonly users: Collection<SlackUserRecord>;
  readonly conversations: Collection<SlackConversationRecord>;
  readonly #messages = new Map<string, SlackMessageRecord[]>();
  readonly #threads = new Map<string, SlackThreadState>();
  /** Files the app uploaded, by id. */
  readonly files = new Map<string, SlackFileRecord>();
  /** What an interaction handed the app to answer with: its `response_url`s, by the key in the URL. */
  readonly responseUrls = new Map<string, SlackResponseUrl>();
  /** `trigger_id`s the app may open a modal with, and until when. */
  readonly triggers = new Map<string, { session: string; user: string; expiresAt: number; used: boolean }>();
  /** `drop_socket` faults that haven't fired yet, by fault id. */
  readonly pendingDrops = new Map<string, { session: string; cancel(): void }>();
  /** Every modal the app opened, by view id. A submitted or closed one stays, marked `closed`. */
  readonly views = new Map<string, SlackViewRecord>();
  /** Conversation ids in creation order: the registry has no listing, and Slack lists conversations. */
  readonly #known: string[] = [];
  /** The session that uninstalled the app, so closing it installs the app again. */
  uninstalledBy: string | undefined;
  /** Faults sessions injected into the Web API. They apply to every caller until removed. */
  readonly faults: SlackFault[] = [];
  #team: SlackTeam | undefined;
  #app: SlackAppRecord | undefined;

  constructor(registry: Registry) {
    this.users = registry.collection<SlackUserRecord>("slack", "user");
    this.conversations = registry.collection<SlackConversationRecord>("slack", "conversation");
  }

  get team(): SlackTeam {
    if (!this.#team) throw new Error("The Slack fake hasn't been seeded");
    return this.#team;
  }

  get app(): SlackAppRecord {
    if (!this.#app) throw new Error("The Slack fake hasn't been seeded");
    return this.#app;
  }

  seed(team: SlackTeam, app: SlackAppRecord): void {
    this.#messages.clear();
    this.#threads.clear();
    this.#known.length = 0;
    this.#people.clear();
    this.faults.length = 0;
    this.uninstalledBy = undefined;
    this.#team = team;
    this.#app = app;
  }

  /** Every message of a conversation, in the order they were posted (replies included). */
  messagesIn(conversation: string): SlackMessageRecord[] {
    let messages = this.#messages.get(conversation);
    if (!messages) {
      messages = [];
      this.#messages.set(conversation, messages);
    }
    return messages;
  }

  /** What the app has said about its work in a thread. Created on first use. */
  threadState(conversation: string, threadTs: string): SlackThreadState {
    const key = `${conversation}:${threadTs}`;
    let state = this.#threads.get(key);
    if (!state) {
      state = { statusText: "", sessionStatus: undefined };
      this.#threads.set(key, state);
    }
    return state;
  }

  findMessage(conversation: string, ts: string): SlackMessageRecord | undefined {
    return this.#messages.get(conversation)?.find((message) => message.ts === ts);
  }

  removeMessage(conversation: string, ts: string): void {
    const messages = this.messagesIn(conversation);
    const index = messages.findIndex((message) => message.ts === ts);
    if (index !== -1) messages.splice(index, 1);
  }

  /** The conversations a session owns. Names are unique among these (decision 0006). */
  conversationsOf(session: string): SlackConversationRecord[] {
    return this.allConversations().filter((conversation) => this.conversations.owner(conversation.id) === session);
  }

  addConversation(conversation: SlackConversationRecord, session: string): SlackConversationRecord {
    this.#known.push(conversation.id);
    return this.conversations.add(conversation.id, conversation, session);
  }

  /** Every conversation, for the provider API's listings. */
  allConversations(): SlackConversationRecord[] {
    return this.#known
      .map((id) => this.conversations.find(id))
      .filter((conversation): conversation is SlackConversationRecord => conversation !== undefined);
  }

  /** User ids per session, in creation order: `@name` in a test's text resolves among its own people. */
  readonly #people = new Map<string, string[]>();

  rememberUser(id: string, session: string): void {
    this.#people.set(session, [...(this.#people.get(session) ?? []), id]);
  }

  /** Every person in the workspace, for the provider API's listings. */
  allUsers(): SlackUserRecord[] {
    return [...this.#people.keys()].flatMap((session) => this.usersOf(session));
  }

  usersOf(session: string): SlackUserRecord[] {
    return (this.#people.get(session) ?? [])
      .map((id) => this.users.find(id))
      .filter((user): user is SlackUserRecord => user !== undefined);
  }

  /**
   * Drop the messages and listings of what a closed session owned, and return its people. Call
   * before the registry releases the objects.
   */
  release(session: string): SlackUserRecord[] {
    // What a session changed for the whole workspace is undone with it (decision 0006).
    if (this.uninstalledBy === session) {
      this.app.installed = true;
      this.uninstalledBy = undefined;
    }
    for (const fault of [...this.faults])
      if (fault.session === session) this.faults.splice(this.faults.indexOf(fault), 1);
    for (const [key, url] of this.responseUrls) if (url.session === session) this.responseUrls.delete(key);
    for (const [id, trigger] of this.triggers) if (trigger.session === session) this.triggers.delete(id);
    for (const [id, view] of this.views) if (view.session === session) this.views.delete(id);
    for (const [id, drop] of this.pendingDrops) {
      if (drop.session !== session) continue;
      drop.cancel();
      this.pendingDrops.delete(id);
    }
    const people = this.usersOf(session);
    this.#people.delete(session);
    for (const id of [...this.#known]) {
      if (this.conversations.owner(id) !== session) continue;
      this.#messages.delete(id);
      for (const file of [...this.files.values()]) if (file.conversation === id) this.files.delete(file.id);
      for (const key of [...this.#threads.keys()]) if (key.startsWith(`${id}:`)) this.#threads.delete(key);
      this.#known.splice(this.#known.indexOf(id), 1);
    }
    return people;
  }
}
