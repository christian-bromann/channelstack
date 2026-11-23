import type { Clock } from "../../../core/clock/index.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { IdGenerator } from "../../../core/ids/index.ts";
import {
  actionRequires,
  fakeActorInLiveWorld,
  liveMisconfigured,
  unsupportedInLive,
} from "../../../core/reality/index.ts";
import type { LiveContext } from "../../../core/router/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import { mentionedUsers, resolveMentions } from "../mentions.ts";
import {
  type SlackAppRecord,
  type SlackConversationKind,
  type SlackConversationRecord,
  type SlackMessageInput,
  type SlackMessageRecord,
  SlackRefusal,
  type SlackTeam,
  type SlackUserRecord,
  type SlackWorld,
} from "../world.ts";
import type { SlackCredentials } from "./cleanup.ts";
import type { SlackAnswer, SlackWebClient } from "./client.ts";
import { checkSlackCredential, identify } from "./identity.ts";

/** How long a read of real Slack is reused: matchers poll every 50ms, and Slack's read methods allow about one call a second. */
const READ_TTL_MS = 1000;
/** Slack's limit for a channel name. */
const MAX_CHANNEL_NAME = 80;

/** A message as Slack's read methods and `chat.postMessage` return it: the fields the transcript needs. */
interface WireMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  text?: string;
  blocks?: unknown[];
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
  edited?: { ts: string };
  reactions?: Array<{ name: string; users?: string[] }>;
  metadata?: unknown;
  files?: Array<{ id: string; name?: string; title?: string; size?: number; user?: string; created?: number }>;
}

interface WireUser {
  id: string;
  name: string;
  real_name?: string;
  tz?: string;
  is_admin?: boolean;
  is_owner?: boolean;
  is_restricted?: boolean;
  is_bot?: boolean;
  profile?: { display_name?: string; real_name?: string; bot_id?: string };
}

/** A person of a session: the real account behind their token, or a fake one that can't act here. */
interface LivePerson {
  readonly record: SlackUserRecord;
  /** The name the test gave them (`createUser({ name: "Ana" })`), which `@Ana` resolves against too. */
  readonly alias: string;
  readonly credential: LiveCredential | undefined;
}

export interface LiveSlackWorld extends SlackWorld {
  /** The check before the first live action: the bot token works and its workspace is allowlisted. */
  ready(): Promise<void>;
  /** Forget what a closed session made: the ledger has already removed it from Slack. */
  release(session: string): void;
  /** The credentials of a session's people and the app, for removing what the session made. */
  credentials(session: string): SlackCredentials;
}

/** A name a channel can have: lowercase letters, digits, `-` and `_`. */
const channelSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * The live Slack world (live-mode.md, A1 and A2): people act with their own tokens, the app's bot
 * token reads, and every channel and DM message a session makes is in the ledger. What a session
 * made is mirrored here, so looking it up never waits for Slack.
 */
export function createLiveWorld(deps: {
  client: SlackWebClient;
  live: LiveContext;
  ids: IdGenerator;
  clock: Clock;
  /** The app's name as tests write it (`@my-agent`), whatever its bot is called in the workspace. */
  appName: string;
}): LiveSlackWorld {
  const { client, live, ids, clock } = deps;
  const bot = live.vault.fromEnv("CHANNELSTACK_SLACK_BOT_TOKEN");
  // An id, not a secret: read as it is, not held as a credential.
  const appId = live.vault.setting("CHANNELSTACK_SLACK_APP_ID") ?? "";

  let identity: { team: SlackTeam; app: SlackAppRecord } | undefined;
  let checked: Promise<void> | undefined;
  const people = new Map<string, Map<string, LivePerson>>();
  const conversations = new Map<string, Map<string, SlackConversationRecord>>();
  /** People nobody in a session created who wrote or were mentioned in what a session read. */
  const others = new Map<string, SlackUserRecord>();
  const reads = new Map<string, { at: number; answer: Promise<unknown> }>();
  let channelCount = 0;

  const known = () => {
    if (!identity) throw new Error("The live Slack world isn't ready: the router checks it before every action");
    return identity;
  };
  const botCredential = (): LiveCredential => {
    if (!bot) throw liveMisconfigured("CHANNELSTACK_SLACK_BOT_TOKEN isn't set", "set the app's bot token (xoxb-)");
    return bot;
  };
  const peopleOf = (session: string) => people.get(session) ?? new Map<string, LivePerson>();
  const conversationsOf = (session: string) => conversations.get(session) ?? new Map<string, SlackConversationRecord>();

  const userRecord = (user: WireUser): SlackUserRecord => ({
    id: user.id,
    name: user.name,
    displayName: user.profile?.display_name || user.real_name || user.name,
    realName: user.profile?.real_name || user.real_name || user.name,
    // A real person's email never leaves the server.
    email: undefined,
    timezone: user.tz ?? "UTC",
    isAdmin: user.is_admin === true || user.is_owner === true,
    isOwner: user.is_owner === true,
    isGuest: user.is_restricted === true,
    isBot: user.is_bot === true,
    botId: user.profile?.bot_id,
    fixedId: false,
  });

  /** Someone this session's view needs a name for: a person of the session, the app's bot, or someone else in the workspace. */
  const ensureKnown = async (session: string, userIds: Iterable<string>) => {
    for (const id of new Set(userIds)) {
      if (id === known().app.botUserId || peopleOf(session).has(id) || others.has(id)) continue;
      try {
        const answer = await client.call("users.info", botCredential(), { user: id });
        others.set(id, userRecord(answer.user as WireUser));
      } catch (error) {
        // An id nobody has (a model made it up) is shown as it is, as Slack does.
        if (!(error instanceof SlackRefusal)) throw error;
      }
    }
  };

  const person = (session: string, id: string): LivePerson => {
    const found = peopleOf(session).get(id);
    if (!found) throw new ProtocolError("not_found", `No person ${id} in this session`, { user: id });
    return found;
  };
  /** The person acting, who must be real: a fake person can't act in a live workspace (core's rule). */
  const actor = (session: string, id: string): LiveCredential => {
    const found = person(session, id);
    if (!found.credential) throw fakeActorInLiveWorld(found.alias, "slack");
    return found.credential;
  };
  const conversation = (session: string, id: string): SlackConversationRecord => {
    const found = conversationsOf(session).get(id);
    if (!found) throw new ProtocolError("not_found", `No conversation ${id} in this session`, { channel: id });
    return found;
  };
  /** A participant's Slack user id: a person of the session (real), or the app's bot. */
  const participant = (session: string, id: string): string => {
    const { app } = known();
    if (id === app.id || id === app.botUserId) return app.botUserId;
    actor(session, id);
    return id;
  };

  const resolveName = (session: string, name: string): string | undefined => {
    if (name === deps.appName) return known().app.botUserId;
    const wanted = name.toLowerCase();
    return [...peopleOf(session).values()].find(
      ({ record, alias }) =>
        alias.toLowerCase() === wanted ||
        record.name.toLowerCase() === wanted ||
        record.displayName.toLowerCase() === wanted,
    )?.record.id;
  };

  /** Who reads a conversation: a real person of the session in it, else the app. */
  const reader = (session: string, channel: string): LiveCredential => {
    const members = conversationsOf(session).get(channel)?.members;
    for (const candidate of peopleOf(session).values()) {
      if (candidate.credential && (members === undefined || members.has(candidate.record.id)))
        return candidate.credential;
    }
    return botCredential();
  };

  const cached = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const hit = reads.get(key);
    if (hit && clock() - hit.at < READ_TTL_MS) return hit.answer as Promise<T>;
    const answer = load();
    reads.set(key, { at: clock(), answer });
    answer.catch(() => reads.delete(key));
    return answer;
  };
  /** What this server wrote in a conversation is read fresh, not from a cached read. */
  const changed = (channel: string) => {
    for (const key of reads.keys()) if (key.includes(`:${channel}:`)) reads.delete(key);
  };

  const toRecord = (message: WireMessage, channel: string): SlackMessageRecord => {
    const { app } = known();
    const user = message.user ?? (message.bot_id === app.botId ? app.botUserId : (message.bot_id ?? ""));
    return {
      ts: message.ts,
      conversation: channel,
      user,
      text: message.text ?? "",
      blocks: message.blocks ?? [],
      threadTs: message.thread_ts !== undefined && message.thread_ts !== message.ts ? message.thread_ts : undefined,
      edited: message.edited?.ts,
      reactions: (message.reactions ?? []).map((reaction) => ({ name: reaction.name, users: reaction.users ?? [] })),
      ephemeralFor: undefined,
      deliveries: [],
      metadata: message.metadata,
      stream: undefined,
      broadcast: message.subtype === "thread_broadcast",
      files: (message.files ?? []).map((file) => ({
        id: file.id,
        name: file.name ?? "",
        title: file.title ?? file.name ?? "",
        size: file.size ?? 0,
        user: file.user ?? user,
        created: file.created ?? 0,
        bytes: undefined,
        conversation: channel,
      })),
    };
  };

  /** Records, with everyone who wrote them or is mentioned in them known by name. */
  const records = async (session: string, channel: string, messages: WireMessage[]) => {
    const list = messages.map((message) => toRecord(message, channel)).sort((a, b) => a.ts.localeCompare(b.ts));
    await ensureKnown(session, [
      ...list.map((message) => message.user),
      ...list.flatMap((message) => mentionedUsers(message.text)),
      ...list.flatMap((message) => message.reactions.flatMap((reaction) => reaction.users)),
    ]);
    return list;
  };

  const history = (session: string, channel: string) =>
    cached(`history:${channel}:`, () =>
      client.all<WireMessage>("conversations.history", reader(session, channel), "messages", { channel }),
    );
  const threadOf = (session: string, channel: string, ts: string) =>
    cached(`replies:${channel}:${ts}`, () =>
      client.all<WireMessage>("conversations.replies", reader(session, channel), "messages", { channel, ts }),
    );

  const messageAt = async (session: string, channel: string, ts: string): Promise<SlackMessageRecord> => {
    conversation(session, channel);
    const top = (await history(session, channel)).find((message) => message.ts === ts);
    // A reply isn't in the history: asking for its thread from the reply finds it.
    const found = top ?? (await threadOf(session, channel, ts)).find((message) => message.ts === ts);
    if (!found) throw new SlackRefusal("message_not_found", `No message ${ts} in ${channel}`, { channel, ts });
    const [record] = await records(session, channel, [found]);
    return record as SlackMessageRecord;
  };

  const mirror = (session: string, record: SlackConversationRecord) => {
    const map = conversations.get(session) ?? new Map<string, SlackConversationRecord>();
    map.set(record.id, record);
    conversations.set(session, map);
    return record;
  };

  /**
   * A DM can't be archived, and other sessions may write in the same one: the ledger lists each
   * message this session wrote there, and cleanup deletes those and the replies under them.
   */
  const recordDm = (
    session: string,
    record: SlackConversationRecord,
    by: LiveCredential,
    ts: string,
    thread: string | undefined,
  ) => {
    live.ledger.record({
      channel: "slack",
      kind: "message",
      ref: { channel: record.id, ts, ...(thread === undefined ? {} : { thread }) },
      workspace: known().team.id,
      by: by.owner,
      session,
    });
  };

  const open = async (session: string, userId: string, others: readonly string[]) => {
    const credential = actor(session, userId);
    const users = others.map((id) => participant(session, id));
    const answer = await client.call("conversations.open", credential, { users: users.join(","), return_im: true });
    const channel = answer.channel as { id: string; created?: number };
    const existing = conversationsOf(session).get(channel.id);
    if (existing) return existing;
    const kind: SlackConversationKind = users.length === 1 ? "im" : "mpim";
    return mirror(session, {
      id: channel.id,
      kind,
      name: undefined,
      members: new Set([userId, ...users]),
      topic: "",
      purpose: "",
      creator: userId,
      created: channel.created ?? Math.floor(clock() / 1000),
      isArchived: false,
    });
  };

  const post = async (
    session: string,
    userId: string,
    target: SlackConversationRecord,
    input: SlackMessageInput,
    thread: { ts: string; broadcast: boolean } | undefined,
  ): Promise<SlackMessageRecord> => {
    const credential = actor(session, userId);
    const text = resolveMentions(input.text ?? "", (name) => resolveName(session, name));
    const answer: SlackAnswer = await client.call("chat.postMessage", credential, {
      channel: target.id,
      text,
      blocks: input.blocks,
      metadata: input.metadata as object | undefined,
      thread_ts: thread?.ts,
      reply_broadcast: thread?.broadcast === true ? true : undefined,
    });
    changed(target.id);
    const message = (answer.message ?? { ts: answer.ts, text, user: userId }) as WireMessage;
    if (target.kind === "im" || target.kind === "mpim") recordDm(session, target, credential, message.ts, thread?.ts);
    // A user token issued by the agent's own app posts as that app: Slack marks the message with the
    // app's bot, and the agent ignores it as its own (found in the first live run, live-mode.md V1).
    const { app } = known();
    if (message.bot_id === app.botId || (app.id !== "" && message.app_id === app.id)) {
      throw liveMisconfigured(
        `${person(session, userId).alias}'s token was issued by the agent's own app, so Slack shows the message as the app's and the agent ignores it`,
        "install a separate Slack app for the sandbox's people and use the user token it issues",
      );
    }
    const [record] = await records(session, target.id, [{ ...message, ts: (answer.ts as string) ?? message.ts }]);
    return record as SlackMessageRecord;
  };

  const notHere = (operation: string, requires: "the browser actor" | "proxy mode") => () => {
    throw actionRequires(operation, requires, "the router refuses it live before it gets here");
  };

  return {
    async ready() {
      checked ??= (async () => {
        const who = await identify(client, botCredential());
        checkSlackCredential(who, { role: "app", who: "CHANNELSTACK_SLACK_BOT_TOKEN", allowlist: live.allowlist });
        const domain = /^https:\/\/([^.]+)\./.exec(who.url)?.[1] ?? "";
        identity = {
          team: { id: who.team, name: who.teamName, domain },
          app: {
            id: appId,
            name: deps.appName,
            botId: who.botId ?? "",
            botUserId: who.user,
            scopes: who.scopes,
            botEvents: [],
            installed: true,
          },
        };
      })().catch((error: unknown) => {
        // A definitive answer is kept, so the next action is refused the same way without asking
        // Slack again. A network error or a rate limit isn't: the next action asks again.
        if (!(error instanceof ProtocolError) || error.code === "ratelimited" || error.code === "unexpected") {
          checked = undefined;
        }
        throw error;
      });
      return checked;
    },

    release(session) {
      people.delete(session);
      conversations.delete(session);
    },

    credentials(session) {
      const real = [...peopleOf(session).values()].filter((candidate) => candidate.credential);
      return {
        byOwner: (owner) =>
          owner === "app" ? bot : real.find((candidate) => candidate.credential?.owner === owner)?.credential,
        byUser: (userId) =>
          userId === identity?.app.botUserId
            ? bot
            : real.find((candidate) => candidate.record.id === userId)?.credential,
      };
    },

    team: () => known().team,
    app: () => known().app,
    socketConnections: () => 0,

    async createUser(session, options) {
      if (options.id !== undefined) {
        throw unsupportedInLive(
          "SlackFixture.createUser({ id })",
          "real ids are assigned by Slack; a live person has the id of their account",
        );
      }
      if (options.bot === true) {
        throw unsupportedInLive(
          "SlackFixture.createUser({ bot })",
          "no API creates a bot in a workspace; use a pre-provisioned one",
        );
      }
      const map = people.get(session) ?? new Map<string, LivePerson>();
      people.set(session, map);
      if (options.token === undefined) {
        if (live.strict) {
          throw liveMisconfigured(
            `CHANNELSTACK_REALITY is live and ${options.name} has no token`,
            "set CHANNELSTACK_SLACK_USER_<NAME>_TOKEN for them, or run without CHANNELSTACK_REALITY=live",
          );
        }
        // A fake person can exist next to a live workspace, but can't act in it.
        const id = ids.next("slack.user");
        const record: SlackUserRecord = {
          id,
          name: options.name,
          displayName: options.displayName ?? options.name,
          realName: options.realName ?? options.name,
          email: undefined,
          timezone: options.timezone ?? "UTC",
          isAdmin: false,
          isOwner: false,
          isGuest: false,
          isBot: false,
          botId: undefined,
          fixedId: false,
        };
        map.set(id, { record, alias: options.name, credential: undefined });
        return record;
      }
      const credential = live.vault.person(options.name, options.token);
      const who = await identify(client, credential);
      checkSlackCredential(who, {
        role: "person",
        who: `${options.name}'s token`,
        allowlist: live.allowlist,
        appTeam: known().team.id,
      });
      const info = await client.call("users.info", botCredential(), { user: who.user });
      const record = userRecord(info.user as WireUser);
      map.set(record.id, { record, alias: options.name, credential });
      return record;
    },

    async createChannel(session, options) {
      const { team, app } = known();
      const members = options.participants.map((id) => participant(session, id));
      const creatorId =
        members.find((id) => id !== app.botUserId) ??
        [...peopleOf(session).values()].find((candidate) => candidate.credential)?.record.id;
      if (creatorId === undefined) {
        throw actionRequires(
          "SlackFixture.createChannel",
          "a real person",
          "a live channel is created by a person with a token; the app's bot can't create channels",
        );
      }
      const creator = actor(session, creatorId);
      // Names are unique in a real workspace: every live channel carries the run's tag and a number.
      const name = [live.tag, String(++channelCount), ...(options.name ? [channelSlug(options.name)] : [])]
        .join("-")
        .slice(0, MAX_CHANNEL_NAME);
      const answer = await client.call("conversations.create", creator, { name, is_private: options.private === true });
      const channel = answer.channel as { id: string; name: string; created?: number };
      live.ledger.record({
        channel: "slack",
        kind: "channel",
        ref: { channel: channel.id, name: channel.name },
        workspace: team.id,
        by: creator.owner,
        session,
      });
      const invited = members.filter((id) => id !== creatorId);
      if (invited.length > 0)
        await client.call("conversations.invite", creator, { channel: channel.id, users: invited.join(",") });
      if (options.topic)
        await client.call("conversations.setTopic", creator, { channel: channel.id, topic: options.topic });
      if (options.purpose)
        await client.call("conversations.setPurpose", creator, { channel: channel.id, purpose: options.purpose });
      return mirror(session, {
        id: channel.id,
        kind: options.private === true ? "private_channel" : "channel",
        name: channel.name,
        members: new Set([creatorId, ...invited]),
        topic: options.topic ?? "",
        purpose: options.purpose ?? "",
        creator: creatorId,
        created: channel.created ?? Math.floor(clock() / 1000),
        isArchived: false,
      });
    },

    openConversation: (session, user, withParticipants) => open(session, user, withParticipants),

    async postAsUser(session, user, message, where) {
      const target = "channel" in where ? conversation(session, where.channel) : await open(session, user, where.to);
      return post(session, user, target, message, undefined);
    },

    async replyAsUser(session, user, message, thread, alsoSendToChannel) {
      const root = await messageAt(session, thread.channel, thread.ts);
      return post(session, user, conversation(session, thread.channel), message, {
        ts: root.threadTs ?? root.ts,
        broadcast: alsoSendToChannel,
      });
    },

    async editAsUser(session, user, message, target) {
      const credential = actor(session, user);
      const text = resolveMentions(message.text ?? "", (name) => resolveName(session, name));
      await client.call("chat.update", credential, {
        channel: target.channel,
        ts: target.ts,
        text,
        blocks: message.blocks,
      });
      changed(target.channel);
      return messageAt(session, target.channel, target.ts);
    },

    async deleteAsUser(session, user, target) {
      await client.call("chat.delete", actor(session, user), { channel: target.channel, ts: target.ts });
      changed(target.channel);
    },

    async reactAsUser(session, user, emoji, target, action) {
      await client.call(action === "add" ? "reactions.add" : "reactions.remove", actor(session, user), {
        channel: target.channel,
        timestamp: target.ts,
        name: emoji.replace(/^:|:$/g, ""),
      });
      changed(target.channel);
      // Real Slack tells the agent itself; channelstack has no delivery to show.
      return undefined;
    },

    async invite(session, user, participants, channel) {
      const credential = actor(session, user);
      const users = participants.map((id) => participant(session, id));
      await client.call("conversations.invite", credential, { channel, users: users.join(",") });
      for (const id of users) conversation(session, channel).members.add(id);
    },

    async kick(session, user, participant_, channel) {
      const credential = actor(session, user);
      const target = participant(session, participant_);
      await client.call("conversations.kick", credential, { channel, user: target });
      conversation(session, channel).members.delete(target);
    },

    conversation,
    conversations: (session) => [...conversationsOf(session).values()],
    users: (session) => [...peopleOf(session).values()].map((candidate) => candidate.record),
    user(session, id) {
      const found = peopleOf(session).get(id)?.record ?? others.get(id);
      if (!found) throw new ProtocolError("not_found", `No person ${id} here`, { user: id });
      return found;
    },

    message: messageAt,

    async messages(session, channel) {
      conversation(session, channel);
      const top = (await history(session, channel)).filter(
        (message) =>
          message.thread_ts === undefined || message.thread_ts === message.ts || message.subtype === "thread_broadcast",
      );
      return records(session, channel, top);
    },

    async replies(session, channel, ts) {
      conversation(session, channel);
      const thread = await threadOf(session, channel, ts);
      return records(
        session,
        channel,
        thread.filter((message) => message.ts !== ts),
      );
    },

    async thread(session, channel, ts) {
      const root = await messageAt(session, channel, ts);
      const rootTs = root.threadTs ?? root.ts;
      return records(session, channel, await threadOf(session, channel, rootTs));
    },

    async everything(session, channel) {
      conversation(session, channel);
      const top = await history(session, channel);
      const threads = await Promise.all(
        top
          .filter((message) => (message.reply_count ?? 0) > 0)
          .map((message) => threadOf(session, channel, message.ts)),
      );
      const all = new Map<string, WireMessage>();
      for (const message of [...top, ...threads.flat()]) all.set(message.ts, message);
      return records(session, channel, [...all.values()]);
    },

    // The router refuses these live (`live` on their routes): they are UI-only or need proxy mode.
    clickAsUser: notHere("SlackUser.click", "the browser actor"),
    selectAsUser: notHere("SlackUser.select", "the browser actor"),
    shortcutAsUser: notHere("SlackUser.shortcut", "the browser actor"),
    commandAsUser: notHere("SlackUser.runCommand", "the browser actor"),
    stopAsUser: notHere("SlackUser.stop", "the browser actor"),
    openAgentThread: notHere("SlackUser.openAgentThread", "the browser actor"),
    pickPrompt: notHere("SlackUser.pickPrompt", "the browser actor"),
    switchContext: notHere("SlackUser.switchContext", "the browser actor"),
    suggestedPrompts: notHere("SlackThread.suggestedPrompts", "proxy mode"),
    modals: notHere("SlackUser.modals", "proxy mode"),
    modal: notHere("SlackModal", "proxy mode"),
    submitModal: notHere("SlackModal.submit", "the browser actor"),
    closeModal: notHere("SlackModal.close", "the browser actor"),
    threadState: notHere("SlackThread.status", "proxy mode"),
    ephemeral: notHere("SlackUser.ephemeral", "proxy mode"),
  };
}
