import type { Clock } from "../../../core/clock/index.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import { LivePeople } from "../../../core/people/index.ts";
import {
  checkOnce,
  checkRoles,
  fakeActorInLiveWorld,
  liveMisconfigured,
  personWithoutToken,
  unsupportedInLive,
} from "../../../core/reality/index.ts";
import { Registry } from "../../../core/registry/index.ts";
import { richTextPieces } from "../../../core/rich-text/index.ts";
import type { LiveContext } from "../../../core/router/index.ts";
import { taggedNames } from "../../../core/safety/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import { PERMISSIONS } from "../permissions.ts";
import type {
  DiscordAppRecord,
  DiscordChannelRecord,
  DiscordGuildRecord,
  DiscordMessageInput,
  DiscordMessageRecord,
  DiscordUserRecord,
  DiscordWorld,
} from "../world.ts";
import { NO_BOT_DMS, NO_INTERACTIONS } from "../world.ts";
import type { DiscordRestClient } from "./client.ts";
import { checkDiscordCredential, identifyDiscord } from "./identity.ts";

/** A message as Discord's REST API answers it, the fields the live world reads. */
interface WireMessage {
  id: string;
  channel_id: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  content: string;
  embeds?: unknown[];
  components?: unknown[];
  type: number;
  flags?: number;
  timestamp: string;
  edited_timestamp?: string | null;
  mentions?: Array<{ id: string }>;
  message_reference?: { message_id?: string };
  reactions?: Array<{ emoji: { name: string | null }; count: number; me: boolean }>;
  thread?: { id: string };
}

interface WireChannel {
  id: string;
  type: number;
  name?: string;
  parent_id?: string | null;
  owner_id?: string;
  recipients?: Array<{ id: string }>;
}

/** What the bot may do in a channel it makes: everything a conversational bot does there. */
const BOT_ALLOW =
  PERMISSIONS.VIEW_CHANNEL |
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.SEND_MESSAGES_IN_THREADS |
  PERMISSIONS.CREATE_PUBLIC_THREADS |
  PERMISSIONS.ADD_REACTIONS |
  PERMISSIONS.READ_MESSAGE_HISTORY |
  PERMISSIONS.EMBED_LINKS;
/**
 * What a person's bot may do in a channel the agent's bot makes: what a person does there. The
 * guild's `@everyone` may not see the channel, so each participant is let in by name.
 */
const PERSON_ALLOW =
  PERMISSIONS.VIEW_CHANNEL |
  PERMISSIONS.READ_MESSAGE_HISTORY |
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.SEND_MESSAGES_IN_THREADS |
  PERMISSIONS.CREATE_PUBLIC_THREADS |
  PERMISSIONS.ADD_REACTIONS |
  PERMISSIONS.EMBED_LINKS;
/** What nobody but an admin may do in a read-only channel: write in it, or react. */
const READ_ONLY_DENY = PERMISSIONS.SEND_MESSAGES | PERMISSIONS.ADD_REACTIONS;

/** An API message as the routes read one. */
function recordOf(message: WireMessage, reactions: DiscordMessageRecord["reactions"] = []): DiscordMessageRecord {
  return {
    id: message.id,
    channelId: message.channel_id,
    authorId: message.author.id,
    content: message.content,
    embeds: message.embeds ?? [],
    components: message.components ?? [],
    replyTo: message.message_reference?.message_id,
    type: message.type,
    flags: message.flags ?? 0,
    mentions: (message.mentions ?? []).map((user) => user.id),
    createdAt: Date.parse(message.timestamp),
    editedAt: message.edited_timestamp ? Date.parse(message.edited_timestamp) : undefined,
    reactions:
      reactions.length > 0
        ? reactions
        : (message.reactions ?? []).flatMap((reaction) =>
            reaction.emoji.name ? [{ emoji: reaction.emoji.name, users: [] }] : [],
          ),
    threadId: message.thread?.id,
    deliveries: [],
  };
}

/**
 * The live Discord world: the agent's bot is a real one in the sandbox guild. The bot makes each
 * session's channels (private to their participants, tagged with the run) and reads everything
 * back. A person is a second bot in the guild, of an application of its own, and writes, replies,
 * edits, reacts and starts threads through Discord's API with its token: Discord has no API that
 * acts as a person, and automating a person's account breaks its terms (decision 0026). What it
 * writes carries `author.bot`, a recorded difference. channelstack never delivers to the agent:
 * Discord does.
 */
export function createLiveDiscordWorld(deps: {
  client: DiscordRestClient;
  live: LiveContext;
  clock: Clock;
  appName: string;
}): DiscordWorld & { ready(): Promise<void>; release(session: string): void } {
  const { client, live, clock } = deps;
  const named = taggedNames(live.tag);
  /** The test's record of each person of a session; the bots that act as them are `actors`'. */
  const people = new Map<string, Map<string, DiscordUserRecord>>();
  const actors = new LivePeople();
  /** Each session's channels: the ones it made, and the threads started in them. */
  const sessionChannels = new Registry().collection<DiscordChannelRecord>("discord", "channel");
  /** Authors the API told of, for a message by someone the session didn't create (the bot's other people). */
  const seen = new Map<string, DiscordUserRecord>();
  let token: LiveCredential | undefined;
  let identity: { app: DiscordAppRecord; guild: DiscordGuildRecord } | undefined;

  const known = () => {
    if (!identity) throw new Error("The live Discord world isn't ready");
    return identity;
  };
  const bot = () => {
    if (!token) throw new Error("The live Discord world isn't ready");
    return token;
  };
  const call = <T>(method: string, path: string, body?: unknown) => client.call<T>(bot(), method, path, body);
  /** What a participant's overwrite allows: the bot's work, a person's, and writing unless it is read-only. */
  const allowFor = (id: string, readOnly: boolean) =>
    (id === known().app.botUserId ? BOT_ALLOW : PERSON_ALLOW) & ~(readOnly ? READ_ONLY_DENY : 0n);

  const prepare = async () => {
    token = live.vault.fromEnv("CHANNELSTACK_DISCORD_BOT_TOKEN");
    if (!token) throw liveMisconfigured("CHANNELSTACK_DISCORD_BOT_TOKEN isn't set", "set the agent's bot token");
    const who = await identifyDiscord(client, token);
    const guild = checkDiscordCredential(who, { who: "CHANNELSTACK_DISCORD_BOT_TOKEN", allowlist: live.allowlist });
    identity = {
      app: {
        id: who.applicationId,
        // The app's name as tests write it (`@my-agent`), whatever its bot is called in the guild, as in Slack's.
        name: deps.appName,
        botUserId: who.botUserId,
        roleId: "",
        privilegedIntents: who.privilegedIntents,
      },
      guild: { id: guild.id, name: guild.name, ownerId: "" },
    };
  };

  const peopleOf = (session: string) => {
    let found = people.get(session);
    if (!found) {
      found = new Map();
      people.set(session, found);
    }
    return found;
  };
  const person = (session: string, id: string) => {
    const found = peopleOf(session).get(id);
    if (!found) throw new ProtocolError("not_found", `No discord user "${id}" in this session`, { id });
    return found;
  };
  /** The token of the bot that acts as a person of the session: a fake person in a live guild has none. */
  const actingAs = (session: string, userId: string) => {
    const found = person(session, userId);
    return actors.actingAs(session, userId, () => fakeActorInLiveWorld(found.name, "discord"));
  };
  /** A call to Discord's API as a person: with their bot's token. */
  const as = <T>(credential: LiveCredential, method: string, path: string, body?: unknown) =>
    client.call<T>(credential, method, path, body);

  /** A channel of the session: one it made, or a thread started in one of them. */
  const channelIn = async (session: string, id: string): Promise<DiscordChannelRecord> => {
    if (sessionChannels.owner(id) === session) return sessionChannels.get(session, id);
    const wire = await call<WireChannel>("GET", `/channels/${id}`);
    if (wire.type === 11 && wire.parent_id && sessionChannels.owner(wire.parent_id) === session) {
      return threadRecord(session, wire, undefined);
    }
    // Not one of the session's: the registry refuses it as `not_found`, as the fake does.
    return sessionChannels.get(session, id);
  };
  const threadRecord = (session: string, wire: WireChannel, starterId: string | undefined) => {
    const thread: DiscordChannelRecord = {
      id: wire.id,
      kind: "public_thread",
      name: wire.name,
      parentId: wire.parent_id ?? undefined,
      starterId,
      ownerId: wire.owner_id,
      members: new Set(),
      readOnly: false,
      createdAt: clock(),
    };
    sessionChannels.add(thread.id, thread, session);
    return thread;
  };

  /** What a person writes for a test's text: mentions as Discord's `<@id>`. */
  const typed = (session: string, text: string) =>
    richTextPieces(text, (name) => {
      if (name === known().app.name) return known().app.botUserId;
      return [...peopleOf(session).values()].find((each) => each.name.toLowerCase() === name.toLowerCase())?.id;
    })
      .map((piece) => ("text" in piece ? piece.text : `<@${piece.mention}>`))
      .join("");
  /** A message's body as Discord's API takes it: the content with mentions, and any embeds. */
  const bodyOf = (session: string, input: DiscordMessageInput) => ({
    ...(input.content === undefined ? {} : { content: typed(session, input.content) }),
    ...(input.embeds === undefined ? {} : { embeds: input.embeds }),
  });

  const history = async (channel: string): Promise<WireMessage[]> =>
    (await call<WireMessage[]>("GET", `/channels/${channel}/messages?limit=100`)).reverse();

  const remember = (message: WireMessage) => {
    if (message.author.id === known().app.botUserId || seen.has(message.author.id)) return;
    seen.set(message.author.id, {
      id: message.author.id,
      name: message.author.global_name ?? message.author.username,
      username: message.author.username,
      admin: false,
      bot: message.author.bot === true,
      fixedId: true,
    });
  };

  const messagePath = (ref: { channel: string; id: string }) => `/channels/${ref.channel}/messages/${ref.id}`;

  return {
    ready: checkOnce(prepare),
    release(session) {
      people.delete(session);
      actors.leave(session);
      sessionChannels.release(session);
    },

    app: () => known().app,
    guild: () => known().guild,
    gatewayConnections: () => 0,

    async createUser(session, options) {
      if (options.bot) {
        throw unsupportedInLive(
          "DiscordFixture.createUser({ bot })",
          "live, every person is a bot of its own already; a bot the agent should leave alone isn't built",
        );
      }
      if (options.id !== undefined) {
        throw unsupportedInLive(
          "DiscordFixture.createUser({ id })",
          "Discord assigns ids: a live person has the id of the bot that acts as them",
        );
      }
      if (options.token === undefined) {
        if (live.strict) {
          throw personWithoutToken(options.name, "discord", {
            lacks: "bot to act as them",
            as: "a second application's bot token",
          });
        }
        // A fake person in a live guild: refused once they act (fake_actor_in_live_world).
        const record = {
          id: `fake-${options.name}`,
          name: options.name,
          username: options.name.toLowerCase(),
          admin: false,
          bot: false,
          fixedId: false,
        };
        peopleOf(session).set(record.id, record);
        return record;
      }
      const credential = live.vault.person(options.name, options.token);
      const who = await identifyDiscord(client, credential, { who: `${options.name}'s token`, role: "person" });
      const { app, guild } = known();
      checkDiscordCredential(who, {
        who: `${options.name}'s token`,
        allowlist: live.allowlist,
        role: "person",
        app: { botUserId: app.botUserId, guildId: guild.id },
      });
      const member = await call<{ roles: string[] }>("GET", `/guilds/${guild.id}/members/${who.botUserId}`);
      const roles = await call<Array<{ id: string; permissions: string }>>("GET", `/guilds/${guild.id}/roles`);
      const admin = roles.some(
        (role) => member.roles.includes(role.id) && (BigInt(role.permissions) & PERMISSIONS.ADMINISTRATOR) !== 0n,
      );
      checkRoles(options.name, [{ option: "admin", wanted: options.admin, has: admin, role: "an administrator" }]);
      const record: DiscordUserRecord = {
        id: who.botUserId,
        name: options.name,
        username: who.name,
        admin,
        // A person in the test, though Discord marks what their bot writes `author.bot` (decision 0026).
        bot: false,
        fixedId: true,
      };
      peopleOf(session).set(record.id, record);
      actors.join(session, record.id, options.name, credential);
      return record;
    },
    user(session, id) {
      const mine = peopleOf(session).get(id);
      const other = mine ?? seen.get(id);
      if (!other) throw new ProtocolError("not_found", `No discord user "${id}" in this session`, { id });
      return other;
    },
    users: (session) => [...peopleOf(session).values()],

    async createChannel(session, options) {
      const { app, guild } = known();
      if (!options.participants.includes(app.botUserId)) {
        throw unsupportedInLive(
          "DiscordFixture.createChannel without the app",
          "live, the bot makes each channel and reads it back, so it is in every channel it makes",
        );
      }
      const others = options.participants.filter((id) => id !== app.botUserId);
      for (const id of others) actingAs(session, id);
      const name = named(options.name)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .slice(0, 100);
      const wire = await call<WireChannel>("POST", `/guilds/${guild.id}/channels`, {
        name,
        type: 0,
        ...(options.topic === undefined ? {} : { topic: options.topic }),
        permission_overwrites: [
          // As the fake's: `@everyone` may not see it, nor write or react in a read-only one; each
          // participant may see it, and writes there only where everyone may.
          {
            id: guild.id,
            type: 0,
            allow: "0",
            deny: String(PERMISSIONS.VIEW_CHANNEL | (options.readOnly ? READ_ONLY_DENY : 0n)),
          },
          ...[app.botUserId, ...others].map((id) => ({
            id,
            type: 1,
            allow: String(allowFor(id, options.readOnly === true)),
            deny: "0",
          })),
        ],
      });
      live.ledger.record({
        channel: "discord",
        kind: "channel",
        ref: { channel: wire.id, name },
        workspace: guild.id,
        by: "app",
        session,
      });
      const record: DiscordChannelRecord = {
        id: wire.id,
        kind: "text",
        name,
        members: new Set(options.participants),
        readOnly: options.readOnly === true,
        topic: options.topic,
        createdAt: clock(),
      };
      sessionChannels.add(record.id, record, session);
      return record;
    },
    channel(session, id) {
      return sessionChannels.get(session, id);
    },
    channels: (session) => sessionChannels.list(session),

    async say(session, user, input, where) {
      const credential = actingAs(session, user);
      if (!("channel" in where)) throw unsupportedInLive("DiscordUser.say({ to })", NO_BOT_DMS);
      const channel = await channelIn(session, where.channel);
      return recordOf(
        await as<WireMessage>(credential, "POST", `/channels/${channel.id}/messages`, bodyOf(session, input)),
      );
    },

    async reply(session, user, input, to) {
      const credential = actingAs(session, user);
      const channel = await channelIn(session, to.channel);
      return recordOf(
        await as<WireMessage>(credential, "POST", `/channels/${channel.id}/messages`, {
          ...bodyOf(session, input),
          message_reference: { message_id: to.id },
        }),
      );
    },

    async edit(session, user, input, message) {
      const credential = actingAs(session, user);
      await channelIn(session, message.channel);
      return recordOf(await as<WireMessage>(credential, "PATCH", messagePath(message), bodyOf(session, input)));
    },

    async delete(session, user, message) {
      const credential = actingAs(session, user);
      await channelIn(session, message.channel);
      await as(credential, "DELETE", messagePath(message));
    },

    async react(session, user, emoji, message, direction) {
      const credential = actingAs(session, user);
      await channelIn(session, message.channel);
      await as(
        credential,
        direction === "add" ? "PUT" : "DELETE",
        `${messagePath(message)}/reactions/${encodeURIComponent(emoji)}/@me`,
      );
      // Discord tells the agent itself: there is no delivery here.
      return undefined;
    },

    async startThread(session, user, name, from) {
      const credential = actingAs(session, user);
      if ("message" in from) {
        await channelIn(session, from.message.channel);
        const wire = await as<WireChannel>(credential, "POST", `${messagePath(from.message)}/threads`, { name });
        return threadRecord(session, wire, from.message.id);
      }
      const parent = await channelIn(session, from.channel);
      const wire = await as<WireChannel>(credential, "POST", `/channels/${parent.id}/threads`, { name, type: 11 });
      return threadRecord(session, wire, undefined);
    },

    openDM(session, user) {
      actingAs(session, user);
      throw unsupportedInLive("DiscordUser.openDM", NO_BOT_DMS);
    },

    async invite(session, user, participants, id) {
      actingAs(session, user);
      const channel = await channelIn(session, id);
      // The bot changes who sees the channel it made: it holds the right to, the person may not.
      for (const participant of participants) {
        await call("PUT", `/channels/${channel.id}/permissions/${participant}`, {
          type: 1,
          allow: String(allowFor(participant, channel.readOnly)),
          deny: "0",
        });
        channel.members.add(participant);
      }
    },

    runCommand() {
      throw unsupportedInLive("DiscordUser.runCommand", NO_INTERACTIONS);
    },
    click() {
      throw unsupportedInLive("DiscordUser.click", NO_INTERACTIONS);
    },

    async messages(session, id) {
      const channel = await channelIn(session, id);
      const messages = await history(channel.id);
      for (const message of messages) remember(message);
      return messages.map((message) => recordOf(message));
    },

    async message(session, id, messageId) {
      const channel = await channelIn(session, id);
      const message = await call<WireMessage>("GET", messagePath({ channel: channel.id, id: messageId }));
      remember(message);
      const reactions = await Promise.all(
        (message.reactions ?? []).flatMap((reaction) =>
          reaction.emoji.name
            ? [
                call<Array<{ id: string }>>(
                  "GET",
                  `${messagePath({ channel: channel.id, id: messageId })}/reactions/${encodeURIComponent(reaction.emoji.name)}`,
                ).then((users) => ({ emoji: reaction.emoji.name as string, users: users.map((each) => each.id) })),
              ]
            : [],
        ),
      );
      return recordOf(message, reactions);
    },

    async replies(session, id, messageId) {
      const channel = await channelIn(session, id);
      const inline = (await history(channel.id)).filter(
        (message) => message.message_reference?.message_id === messageId,
      );
      const root = await call<WireMessage>("GET", messagePath({ channel: channel.id, id: messageId }));
      const thread = root.thread ? await history(root.thread.id) : [];
      if (root.thread) await channelIn(session, root.thread.id).catch(() => undefined);
      const all = [...inline, ...thread];
      for (const message of all) remember(message);
      return all.map((message) => recordOf(message)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    },

    async threads(session, id) {
      const channel = await channelIn(session, id);
      const { threads } = await call<{ threads: WireChannel[] }>("GET", `/guilds/${known().guild.id}/threads/active`);
      const found: DiscordChannelRecord[] = [];
      for (const thread of threads.filter((each) => each.parent_id === channel.id)) {
        found.push(await channelIn(session, thread.id));
      }
      return found;
    },

    ephemeral() {
      throw unsupportedInLive("DiscordUser.ephemeral", "no bot API reads back what only a person sees");
    },
  };
}
