import type { Collection, Registry } from "../../../core/registry/index.ts";
import type { CommandOption } from "../commands.ts";
import type {
  DiscordAppRecord,
  DiscordChannelRecord,
  DiscordGuildRecord,
  DiscordMessageRecord,
  DiscordUserRecord,
} from "../world.ts";

/** One of the app's slash commands, as it registered it: in the guild, or everywhere (global). */
export interface DiscordCommandRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly type: number;
  /** The options a person fills in, as the app declared them. */
  readonly options: readonly CommandOption[];
  /** Undefined for a global command. */
  readonly guildId: string | undefined;
  readonly version: string;
}

/** An interaction a person started, and how the app has answered it so far. */
export interface DiscordInteractionRecord {
  readonly id: string;
  readonly token: string;
  readonly session: string;
  /** 1 a ping, 2 a slash command, 3 a component. */
  readonly type: number;
  readonly userId: string;
  readonly channelId: string;
  /** For a component: the message it is on. */
  readonly messageId: string | undefined;
  /** For a command: its name. */
  readonly name: string | undefined;
  readonly createdAt: number;
  /** The delivery that took it to the app. */
  delivery: string | undefined;
  /** How the app answered: not yet, in time, or not in time (a person saw "This interaction failed"). */
  state: "pending" | "responded" | "failed";
  /** The message its response made (type 4, 5), which `@original` names. */
  original: string | undefined;
}

/** A test's fault on the bot's REST calls or its Gateway connection. */
export interface DiscordFault {
  readonly id: string;
  readonly session: string;
  readonly type: "rate_limit" | "drop_gateway";
  /** For drop_gateway: the connection drops just before this session's next dispatch, once. For rate_limit: only this route (`POST /channels/{channel.id}/messages`); every route when left out. */
  readonly route: string | undefined;
  /** How many more calls it refuses; forever when left out. */
  remaining: number | undefined;
  readonly retryAfterMs: number;
}

/** The Discord fake's in-memory state. Objects live in the core registry; the store adds Discord's own indexes. */
export class DiscordStore {
  readonly users: Collection<DiscordUserRecord>;
  readonly channels: Collection<DiscordChannelRecord>;
  readonly #messages = new Map<string, DiscordMessageRecord[]>();
  /** Channel ids in creation order, and who owns them. */
  readonly #known: string[] = [];
  /** The DM between the bot or a person and another, by both their ids. */
  readonly dms = new Map<string, string>();
  /** The app's commands, by id. They outlive sessions: the agent registers them when it starts. */
  readonly commands = new Map<string, DiscordCommandRecord>();
  /** Interactions by id, and by token. */
  readonly interactions = new Map<string, DiscordInteractionRecord>();
  readonly faults: DiscordFault[] = [];
  #guild: DiscordGuildRecord | undefined;
  #app: DiscordAppRecord | undefined;
  #everyoneRole = "";
  #adminRole = "";

  constructor(registry: Registry) {
    this.users = registry.collection<DiscordUserRecord>("discord", "user");
    this.channels = registry.collection<DiscordChannelRecord>("discord", "channel");
  }

  get guild(): DiscordGuildRecord {
    if (!this.#guild) throw new Error("The Discord fake hasn't been seeded");
    return this.#guild;
  }

  get app(): DiscordAppRecord {
    if (!this.#app) throw new Error("The Discord fake hasn't been seeded");
    return this.#app;
  }

  /** `@everyone`'s role, whose id is the guild's. */
  get everyoneRole(): string {
    return this.#everyoneRole;
  }

  /** The `Admin` role people made with `admin: true` have. */
  get adminRole(): string {
    return this.#adminRole;
  }

  seed(guild: DiscordGuildRecord, app: DiscordAppRecord, adminRole: string): void {
    this.#messages.clear();
    this.#known.length = 0;
    this.dms.clear();
    this.interactions.clear();
    this.faults.length = 0;
    this.#guild = guild;
    this.#app = app;
    this.#everyoneRole = guild.id;
    this.#adminRole = adminRole;
  }

  addChannel(channel: DiscordChannelRecord, session: string): DiscordChannelRecord {
    this.channels.add(channel.id, channel, session);
    this.#known.push(channel.id);
    this.#messages.set(channel.id, []);
    return channel;
  }

  /** A session's channels, threads and DMs, oldest first. */
  channelsOf(session: string): DiscordChannelRecord[] {
    return this.channels.list(session);
  }

  /** Every channel on the platform's side, oldest first. */
  allChannels(): DiscordChannelRecord[] {
    return this.#known.flatMap((id) => this.channels.find(id) ?? []);
  }

  messagesIn(channel: string): DiscordMessageRecord[] {
    return this.#messages.get(channel) ?? [];
  }

  addMessage(message: DiscordMessageRecord): DiscordMessageRecord {
    this.messagesIn(message.channelId).push(message);
    if (!this.#messages.has(message.channelId)) this.#messages.set(message.channelId, [message]);
    return message;
  }

  findMessage(channel: string, id: string): DiscordMessageRecord | undefined {
    return this.messagesIn(channel).find((message) => message.id === id);
  }

  removeMessage(channel: string, id: string): void {
    const list = this.messagesIn(channel);
    const at = list.findIndex((message) => message.id === id);
    if (at >= 0) list.splice(at, 1);
  }

  usersOf(session: string): DiscordUserRecord[] {
    return this.users.list(session);
  }

  /** Forget what a closed session owned. Returns its people, so ids a test fixed are given back. */
  release(session: string): DiscordUserRecord[] {
    const people = this.users.list(session);
    for (const channel of this.channels.list(session)) {
      this.#messages.delete(channel.id);
      const at = this.#known.indexOf(channel.id);
      if (at >= 0) this.#known.splice(at, 1);
    }
    for (const [key, channel] of this.dms) if (this.channels.owner(channel) === session) this.dms.delete(key);
    for (const [id, interaction] of this.interactions)
      if (interaction.session === session) this.interactions.delete(id);
    for (let at = this.faults.length - 1; at >= 0; at--)
      if (this.faults[at]?.session === session) this.faults.splice(at, 1);
    return people;
  }
}
