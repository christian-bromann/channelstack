import { BUILT_IN_APP, checkNameFree } from "../../../core/apps/index.ts";
import { delay } from "../../../core/clock/index.ts";
import type { DeliveryAttempt, DeliveryRecord } from "../../../core/delivery/index.ts";
import { deliveryKit, fixedRetries } from "../../../core/delivery/kit.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { identified } from "../blocks.ts";
import { SLACK_IDS, slackTs } from "../ids.ts";
import { emojiName, mentionedUsers, resolveMentions } from "../mentions.ts";
import {
  appMentionEvent,
  channelMessageEvent,
  eventCallback,
  membershipEvent,
  messageChangedEvent,
  messageDeletedEvent,
  messageEvent,
  messageObject,
  messageSubscription,
  reactionEvent,
  richTextBlock,
} from "../payloads.ts";
import { signSlackRequest } from "../signing.ts";
import {
  type Immediate,
  type SlackAppRecord,
  type SlackConversationKind,
  type SlackConversationRecord,
  type SlackFileRecord,
  type SlackMessageInput,
  type SlackMessageRecord,
  SlackRefusal,
  type SlackUserRecord,
  type SlackWorld,
} from "../world.ts";
import { createInteractions, type InteractionKit } from "./interactions.ts";
import type { SocketModes } from "./socket.ts";
import type { SlackFault, SlackStore } from "./store.ts";
import { createViews } from "./views.ts";

/** Slack expects an acknowledgement within 3 seconds. */
const ACK_WINDOW_MS = 3000;
/** How far back a "stale" delivery is signed: Slack receivers reject anything older than five minutes. */
const STALE_MS = 6 * 60_000;
/** Slack's limit for a message's text. */
const MAX_TEXT_LENGTH = 40_000;
/** The fake keeps files in memory, so it takes small ones only. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Where the fake serves a file's bytes (`url_private`): a path like Slack's `files.slack.com/files-pri/T…-F…/<name>`. */
export const fileUrl = (apiUrl: string, team: string, id: string, name: string) =>
  `${apiUrl}/files-pri/${team}-${id}/${encodeURIComponent(name)}`;

/** A refusal with Slack's own error code. The control API surfaces it; the fake Web API answers with the code. */
const refuse = (code: string, message: string, data: Record<string, unknown> = {}) =>
  new SlackRefusal(code, message, data);

/** What the fake `SlackWorld` adds for the provider API, where the agent acts as the app. */
export interface FakeSlackWorld extends Immediate<SlackWorld> {
  /** Post as the app (`chat.postMessage`). The caller has checked membership and scopes. */
  postAsApp(
    conversation: SlackConversationRecord,
    message: SlackMessageInput,
    options: {
      threadTs?: string | undefined;
      ephemeralFor?: string | undefined;
      files?: readonly SlackFileRecord[] | undefined;
      broadcast?: boolean | undefined;
    },
    /** The app that posts: the built-in one unless another app's token made the call. */
    app?: SlackAppRecord,
  ): SlackMessageRecord;
  /**
   * What happens to a message once the caller has decided the author may do it. People (the
   * control API) and the app (the fake Web API) both end up here; each brings its own permission check.
   */
  checkContent(text: string, blocks: unknown[] | undefined): void;
  /** Replace a message's content and tell the app. Returns the delivery, if one was sent. */
  edit(
    conversation: SlackConversationRecord,
    message: SlackMessageRecord,
    body: { text: string; blocks: unknown[] },
  ): string | undefined;
  /** Remove a message and tell the app. */
  remove(conversation: SlackConversationRecord, message: SlackMessageRecord): void;
  /** Add or remove one person's (or the app's) reaction and tell the app. Returns the delivery, if one was sent. */
  react(
    conversation: SlackConversationRecord,
    message: SlackMessageRecord,
    userId: string,
    emoji: string,
    direction: "add" | "remove",
  ): string | undefined;
  /** `views.open` / `views.push`: open a modal for the person whose `trigger_id` this is. Answers with the view. */
  openView(triggerId: string, view: unknown, onTop: boolean): Record<string, unknown>;
  /** `views.update`: replace an open modal's definition. */
  updateView(viewId: string, hash: string | undefined, view: unknown): Record<string, unknown>;
  /** The app answers an interaction through its `response_url`. False when the URL is unknown, used up or expired. */
  respond(key: string, body: Record<string, unknown>): boolean;
  /** Send an event about a conversation to every app that is subscribed, installed and a member. */
  emit(conversation: SlackConversationRecord, subscription: string, event: Record<string, unknown>): Sent[];
  /**
   * Someone joins a channel, invited by `inviter` or by themselves (`conversations.join`). The app
   * hears `member_joined_channel`, then the `channel_join` message Slack posts in the channel. The
   * caller has checked they may.
   */
  join(conversation: SlackConversationRecord, userId: string, inviter?: string): void;
  /** Someone archives a channel. The app hears the `channel_archive` message. The caller has checked they may. */
  archive(conversation: SlackConversationRecord, userId: string): void;
  /** The user a name in a test's text refers to, in this session. */
  resolveName(session: string, name: string): string | undefined;
  /**
   * The workspace uninstalls an app (the built-in one unless named): it gets `app_uninstalled` and
   * `tokens_revoked`, then nothing more, and its token stops working. Undone when the session that
   * did it closes (decision 0006).
   */
  uninstallApp(session: string, app?: string): string[];
  /** The apps of the workspace, the built-in one first. */
  apps(): SlackAppRecord[];
  /** Make an app by name, or return the one made with the same settings (decision 0027). */
  createApp(
    session: string | undefined,
    options: { name: string; scopes?: readonly string[] | undefined; botEvents?: readonly string[] | undefined },
  ): SlackAppRecord;
  /** An app a test made writes, as its own `chat.postMessage` would: a top-level message, or in a DM. */
  sayAsApp(
    session: string,
    app: string,
    input: SlackMessageInput,
    where: { channel: string } | { to: string[] },
  ): SlackMessageRecord;
  /** An app a test made replies in a thread. */
  replyAsApp(
    session: string,
    app: string,
    input: SlackMessageInput,
    thread: { channel: string; ts: string },
  ): SlackMessageRecord;
  /** An app a test made reacts to a message, or takes its reaction back. */
  reactAsApp(
    session: string,
    app: string,
    emoji: string,
    target: { channel: string; ts: string },
    direction: "add" | "remove",
  ): string | undefined;
  /** The app whose bot user, id or bot id this is. */
  appOf(id: string): SlackAppRecord | undefined;

  deliveries(session: string): DeliveryRecord[];
  delivery(session: string, id: string): DeliveryRecord;
  /** Send a delivery again the way Slack retries: same payload, with the retry headers. */
  retry(session: string, id: string, options: { afterMs: number; reason: string }): Promise<DeliveryAttempt>;
  /** Send a delivery again, unchanged or forged: signed with a wrong secret, or with a stale timestamp. */
  resend(
    session: string,
    id: string,
    options: { badSignature: boolean; stale: boolean; headers?: Record<string, string> | undefined },
  ): Promise<DeliveryAttempt>;
  /** Inject a fault into the Web API. It applies to every caller until removed, or until the session closes. */
  addFault(
    session: string,
    fault: Omit<SlackFault, "id" | "session" | "type"> & { type: SlackFault["type"] | "drop_socket" },
  ): string;
  removeFault(session: string, id: string): void;
}

/** When Slack retries an event the app didn't acknowledge: almost at once, after a minute, after five. */
const RETRY_DELAYS_MS = [0, 60_000, 300_000];

/**
 * Slack's retries: the same payload up to three more times, saying which retry it is and why.
 * A response with `X-Slack-No-Retry: 1` ends them.
 */
const SLACK_RETRIES = fixedRetries(RETRY_DELAYS_MS, (attempt, retries, responseHeaders) => {
  if (responseHeaders?.get("x-slack-no-retry") === "1") return undefined;
  const reason =
    attempt.status === "timed_out" ? "http_timeout" : attempt.status === "failed" ? "http_error" : "connection_failed";
  return { "x-slack-retry-num": String(retries + 1), "x-slack-retry-reason": reason };
});

/** A delivery an event caused, and the app it went to. */
export interface Sent {
  readonly app: string;
  readonly id: string;
}

/** The built-in app's delivery among those an event caused: what a message's `delivery` is. */
export const builtInDelivery = (sent: readonly Sent[]): string | undefined =>
  sent.find((one) => one.app === BUILT_IN_APP)?.id;

export function createFakeWorld(
  context: DriverContext,
  store: SlackStore,
  socket: SocketModes,
  defaults: { scopes: readonly string[]; botEvents: readonly string[] },
): FakeSlackWorld {
  const { ids, clock, events } = context;
  /** Slack's deliveries: signed with the signing secret over the timestamp and the exact body. Events retry; interactions don't. */
  const deliveries = deliveryKit(context, {
    driver: "slack",
    timeoutMs: ACK_WINDOW_MS,
    retry: SLACK_RETRIES,
    sign: (secret, body, atMs) => signSlackRequest(secret, body, atMs),
    secret: (app) => context.apps.secret(app, "signingSecret"),
    staleMs: STALE_MS,
  });

  const author = (id: string): SlackUserRecord | undefined => store.users.find(id);

  const resolveName = (session: string, name: string): string | undefined => {
    const app = store.apps.named(name);
    if (app) return app.botUserId;
    const wanted = name.toLowerCase();
    return store
      .usersOf(session)
      .find((user) => user.name.toLowerCase() === wanted || user.displayName.toLowerCase() === wanted)?.id;
  };

  /** Sign an event and hand it to the delivery queue for one app, for the session whose action caused it. */
  const deliver = (session: string, event: Record<string, unknown>, app: SlackAppRecord): string | undefined => {
    // The app is reached at its request URL, or over the connection it opened (Socket Mode). With neither, nothing is sent.
    const url = context.apps.webhookUrl(app.name);
    const mode = socket.of(app);
    if (url === undefined && mode.transport() === undefined) return undefined;
    const eventId = ids.next(SLACK_IDS.event);
    const payload = eventCallback({
      event,
      eventId,
      atMs: clock(),
      team: store.team,
      app,
      verificationToken: context.apps.secret(app.name, "verificationToken"),
    });
    deliveries.send({
      id: eventId,
      session,
      app: app.name,
      type: "event_callback",
      url: url ?? "",
      transport: mode.transport,
      body: JSON.stringify(payload),
      meta: { eventType: event.type, payload },
    });
    return eventId;
  };

  /** Would the app (the built-in one unless named) be told about this kind of event in this conversation? */
  const hears = (
    conversation: SlackConversationRecord | "dm",
    subscription: string,
    app: SlackAppRecord = store.app,
  ): boolean => {
    // Reachable at all: at its request URL, or over the socket it opened.
    const reachable = context.apps.webhookUrl(app.name) !== undefined || socket.of(app).transport() !== undefined;
    return (
      reachable &&
      app.installed &&
      app.botEvents.includes(subscription) &&
      // The app is always a member of a DM with itself.
      (conversation === "dm" || conversation.members.has(app.botUserId))
    );
  };

  /** Send an event to one app, if it hears it. */
  const emitTo = (
    conversation: SlackConversationRecord,
    subscription: string,
    event: Record<string, unknown>,
    app: SlackAppRecord,
  ): Sent[] => {
    const session = store.conversations.owner(conversation.id);
    if (session === undefined || !hears(conversation, subscription, app)) return [];
    const id = deliver(session, event, app);
    return id === undefined ? [] : [{ app: app.name, id }];
  };

  // Every app in the conversation hears what happens in it, whoever did it: Slack sends one app's
  // messages to the others as it sends a person's (decision 0027). Each gets its own delivery.
  const emit: FakeSlackWorld["emit"] = (conversation, subscription, event) =>
    store.apps.all().flatMap((app) => emitTo(conversation, subscription, event, app));

  const member = (session: string, userId: string, conversation: SlackConversationRecord): SlackUserRecord => {
    const user = store.users.get(session, userId);
    if (!conversation.members.has(user.id)) {
      throw refuse("not_in_channel", `${user.id} is not a member of ${conversation.id}`, {
        user: user.id,
        channel: conversation.id,
      });
    }
    return user;
  };

  const participant = (session: string, id: string): string => {
    const app = store.appOf(id);
    if (app) return app.botUserId;
    return store.users.get(session, id).id;
  };

  const checkContent: FakeSlackWorld["checkContent"] = (text, blocks) => {
    if (text === "" && (blocks === undefined || blocks.length === 0)) {
      throw refuse("no_text", "A message needs text or blocks");
    }
    if (text.length > MAX_TEXT_LENGTH)
      throw refuse("msg_too_long", `A message's text is limited to ${MAX_TEXT_LENGTH} characters`);
  };

  /** A message's blocks: its own, or, for text without blocks, the `rich_text` block Slack makes of the text. */
  const blocksOf = (text: string, blocks: unknown[] | undefined): unknown[] =>
    blocks ?? (text === "" ? [] : [richTextBlock(text, ids.next(SLACK_IDS.block))]);

  const content = (session: string, input: SlackMessageInput): { text: string; blocks: unknown[] } => {
    const text = resolveMentions(input.text ?? "", (name) => resolveName(session, name));
    // A message that shares files needs no text.
    if ((input.files?.length ?? 0) === 0 || text !== "") checkContent(text, input.blocks);
    return { text, blocks: blocksOf(text, input.blocks) };
  };

  /** The files a person shares with a message, as Slack keeps them: theirs, and shared where the message is. */
  const shared = (
    userId: string,
    conversation: SlackConversationRecord,
    input: SlackMessageInput,
  ): SlackFileRecord[] => {
    const files = input.files ?? [];
    // Every file is checked before any is kept, so a refused message leaves none behind.
    for (const { name, bytes } of files) {
      if (name.trim() === "") throw new ProtocolError("invalid_argument", "A file needs a name");
      if (bytes.length > MAX_FILE_BYTES) {
        throw new ProtocolError("invalid_argument", `The fake keeps files in memory: ${name} is over 10 MB`);
      }
    }
    return files.map(({ name, bytes }) => {
      const id = ids.next(SLACK_IDS.file);
      const file: SlackFileRecord = {
        id,
        url: fileUrl(context.apiUrl(), store.team.id, id, name),
        name,
        title: name,
        size: bytes.length,
        user: userId,
        created: Math.floor(clock() / 1000),
        bytes,
        conversation: conversation.id,
      };
      store.files.set(id, file);
      return file;
    });
  };

  /** Write a message and tell the app: `message`, and `app_mention` when the text mentions it. */
  const post = (
    conversation: SlackConversationRecord,
    userId: string,
    body: { text: string; blocks: unknown[] },
    options: {
      threadTs?: string | undefined;
      ephemeralFor?: string | undefined;
      metadata?: unknown;
      files?: readonly SlackFileRecord[] | undefined;
      broadcast?: boolean | undefined;
    },
  ): SlackMessageRecord => {
    const message: SlackMessageRecord = {
      ts: slackTs(ids),
      conversation: conversation.id,
      user: userId,
      text: body.text,
      blocks: identified(body.blocks, () => ids.next(SLACK_IDS.block)),
      threadTs: options.threadTs,
      parentUser:
        options.threadTs === undefined ? undefined : store.findMessage(conversation.id, options.threadTs)?.user,
      edited: undefined,
      reactions: [],
      ephemeralFor: options.ephemeralFor,
      deliveries: [],
      metadata: options.metadata,
      stream: undefined,
      files: options.files ?? [],
      broadcast: options.broadcast === true,
    };
    store.messagesIn(conversation.id).push(message);
    // An ephemeral message exists only for its recipient: Slack sends no event for it.
    if (message.ephemeralFor !== undefined) return message;
    const { team } = store;
    const apps = store.apps.all();
    const mentions = mentionedUsers(message.text);
    // Slack doesn't send `app_mention` for a DM with the app, mentioned or not: that arrives as `message.im` only.
    // Each app a message mentions gets its own; another app's message mentions it like a person's does, with its `bot_id`.
    const mentioned = apps.filter(
      (app) => conversation.kind !== "im" && userId !== app.botUserId && mentions.includes(app.botUserId),
    );
    const botId = author(userId)?.botId ?? store.appOf(userId)?.botId;
    // The mention comes first: when a message causes both, `app_mention` is the one tests look at.
    for (const app of mentioned) {
      for (const sent of emitTo(conversation, "app_mention", appMentionEvent(message, conversation, botId, team), app))
        message.deliveries.push(sent.id);
    }
    const event = messageEvent(message, conversation, author(userId), team, apps);
    for (const sent of emit(conversation, messageSubscription(conversation), event)) message.deliveries.push(sent.id);
    return message;
  };

  const requireMessage = (conversation: SlackConversationRecord, ts: string): SlackMessageRecord => {
    const message = store.findMessage(conversation.id, ts);
    if (!message)
      throw new ProtocolError("not_found", `No message ${ts} in ${conversation.id}`, { channel: conversation.id, ts });
    return message;
  };

  const open = (session: string, creator: string, others: readonly string[]): SlackConversationRecord => {
    const members = new Set([creator, ...others.map((id) => participant(session, id))]);
    if (members.size < 2) throw new ProtocolError("invalid_argument", "A DM needs someone else in it");
    const existing = store
      .conversationsOf(session)
      .find(
        (conversation) =>
          (conversation.kind === "im" || conversation.kind === "mpim") &&
          conversation.members.size === members.size &&
          [...members].every((id) => conversation.members.has(id)),
      );
    if (existing) return existing;
    const kind: SlackConversationKind = members.size === 2 ? "im" : "mpim";
    return store.addConversation(
      {
        id: ids.next(kind === "im" ? SLACK_IDS.dm : SLACK_IDS.mpim),
        kind,
        name: undefined,
        members,
        topic: "",
        purpose: "",
        creator,
        created: Math.floor(clock() / 1000),
        isArchived: false,
      },
      session,
    );
  };

  const action = (session: string, name: string, data: Record<string, unknown>) =>
    events.append(session, "slack", "action", { action: name, ...data });

  /** An app a test made and acts as: never the built-in one, which the agent under test acts as. */
  const scripted = (id: string): SlackAppRecord => {
    const app = store.appOf(id) ?? store.apps.named(id);
    if (!app) throw new ProtocolError("not_found", `There is no Slack app "${id}"`, { app: id });
    if (app === store.app) {
      throw new ProtocolError(
        "invalid_argument",
        `${app.name} is the built-in app, which the agent under test acts as: script another app`,
        { app: app.id },
      );
    }
    if (!app.installed) throw refuse("account_inactive", `${app.name} is uninstalled`);
    return app;
  };

  /** An app writes only where it is a member, as Slack refuses with `not_in_channel`. */
  const appMember = (app: SlackAppRecord, conversation: SlackConversationRecord): void => {
    if (!conversation.members.has(app.botUserId)) {
      throw refuse("not_in_channel", `${app.name} is not a member of ${conversation.id}`, {
        app: app.id,
        channel: conversation.id,
      });
    }
  };

  /** An app's DM with people. A bot can't DM another bot: Slack refuses `conversations.open` with `cannot_dm_bot`. */
  const openForApp = (session: string, app: SlackAppRecord, to: readonly string[]): SlackConversationRecord => {
    const others = to.map((id) => participant(session, id));
    if (others.some((id) => store.isAppUser(id) || store.users.find(id)?.isBot === true)) {
      throw refuse("cannot_dm_bot", "A bot can't open a DM with another bot");
    }
    return open(session, app.botUserId, others);
  };

  const world: Omit<
    FakeSlackWorld,
    keyof ReturnType<typeof createInteractions> | keyof ReturnType<typeof createViews>
  > = {
    team: () => store.team,
    app: () => store.app,
    apps: () => store.apps.all(),
    appOf: (id) => store.appOf(id),
    emit,
    resolveName,

    createApp(session, options) {
      if (session !== undefined) {
        checkNameFree(
          options.name,
          store.usersOf(session).map((user) => user.name),
          "app",
        );
      }
      const scopes = [...(options.scopes ?? defaults.scopes)];
      const botEvents = [...(options.botEvents ?? defaults.botEvents)];
      const app = store.apps.make(options.name, { scopes, botEvents }, () => {
        const appIds = context.apps.ids(options.name);
        return {
          id: appIds.next(SLACK_IDS.app),
          name: options.name,
          botId: appIds.next(SLACK_IDS.bot),
          botUserId: appIds.next(SLACK_IDS.user),
          scopes,
          botEvents,
          installed: true,
          updated: Math.floor(clock() / 1000),
        };
      });
      if (session !== undefined) action(session, "createApp", { app: app.id });
      return app;
    },

    sayAsApp(session, name, input, where) {
      const app = scripted(name);
      const conversation =
        "channel" in where ? store.conversations.get(session, where.channel) : openForApp(session, app, where.to);
      appMember(app, conversation);
      const message = world.postAsApp(conversation, content(session, input), {}, app);
      action(session, "say", { app: app.id, channel: conversation.id, ts: message.ts });
      return message;
    },

    replyAsApp(session, name, input, thread) {
      const app = scripted(name);
      const conversation = store.conversations.get(session, thread.channel);
      appMember(app, conversation);
      const root = requireMessage(conversation, thread.ts);
      const message = world.postAsApp(
        conversation,
        content(session, input),
        { threadTs: root.threadTs ?? root.ts },
        app,
      );
      action(session, "reply", { app: app.id, channel: conversation.id, ts: message.ts });
      return message;
    },

    reactAsApp(session, name, emoji, target, direction) {
      const app = scripted(name);
      const conversation = store.conversations.get(session, target.channel);
      appMember(app, conversation);
      const message = requireMessage(conversation, target.ts);
      const delivery = world.react(conversation, message, app.botUserId, emoji, direction);
      action(session, direction === "add" ? "react" : "unreact", {
        app: app.id,
        channel: conversation.id,
        ts: message.ts,
        emoji: emojiName(emoji),
      });
      return delivery;
    },

    uninstallApp(session, name = BUILT_IN_APP) {
      const { team } = store;
      const app = store.apps.named(name);
      if (!app) throw new ProtocolError("not_found", `There is no Slack app "${name}"`, { app: name });
      if (!app.installed) throw refuse("account_inactive", "The app is already uninstalled");
      const eventTs = Math.floor(clock() / 1000).toString();
      const sent = [
        ["app_uninstalled", { type: "app_uninstalled", event_ts: eventTs }],
        ["tokens_revoked", { type: "tokens_revoked", tokens: { oauth: [], bot: [app.botUserId] }, event_ts: eventTs }],
      ]
        .filter(([subscription]) => app.botEvents.includes(subscription as string))
        .map(([, event]) => deliver(session, { ...(event as Record<string, unknown>), team_id: team.id }, app))
        .filter((id): id is string => id !== undefined);
      app.installed = false;
      store.uninstalledBy.set(app.name, session);
      action(session, "uninstallApp", { app: app.id });
      return sent;
    },

    createUser(session, options) {
      checkNameFree(
        options.name,
        store.apps.all().map((app) => app.name),
        "person",
      );
      // A fixed id must be free in the whole world: the agent can't tell two of them apart (decision 0006).
      const id = options.id === undefined ? ids.next(SLACK_IDS.user) : ids.reserve(SLACK_IDS.user, options.id);
      const user: SlackUserRecord = {
        id,
        name: options.name,
        displayName: options.displayName ?? options.name,
        realName: options.realName ?? options.name,
        email: options.email,
        timezone: options.timezone ?? "America/Los_Angeles",
        isAdmin: options.admin === true || options.owner === true,
        isOwner: options.owner === true,
        isGuest: options.guest === true,
        isBot: options.bot === true,
        botId: options.bot === true ? ids.next(SLACK_IDS.bot) : undefined,
        fixedId: options.id !== undefined,
      };
      store.users.add(id, user, session);
      store.rememberUser(id, session);
      action(session, "createUser", { user: id });
      return user;
    },

    createChannel(session, options) {
      const members = new Set(options.participants.map((id) => participant(session, id)));
      const id = ids.next(SLACK_IDS.channel);
      const name = options.name ?? `test-${id.slice(-6).toLowerCase()}`;
      // Names are unique per session, not per workspace: parallel tests can each have a #support (decision 0006).
      if (store.conversationsOf(session).some((conversation) => conversation.name === name)) {
        throw refuse("name_taken", `This session already has a channel named "${name}"`, { name });
      }
      const [creator = store.app.botUserId] = members;
      const conversation = store.addConversation(
        {
          id,
          kind: options.private === true ? "private_channel" : "channel",
          name,
          members,
          topic: options.topic ?? "",
          purpose: options.purpose ?? "",
          creator,
          created: Math.floor(clock() / 1000),
          isArchived: false,
        },
        session,
      );
      action(session, "createChannel", { channel: id });
      return conversation;
    },

    openConversation(session, userId, withParticipants) {
      return open(session, store.users.get(session, userId).id, withParticipants);
    },

    postAsUser(session, userId, input, where) {
      const user = store.users.get(session, userId);
      const conversation =
        "channel" in where ? store.conversations.get(session, where.channel) : open(session, user.id, where.to);
      member(session, user.id, conversation);
      const body = content(session, input);
      const message = post(conversation, user.id, body, {
        metadata: input.metadata,
        files: shared(user.id, conversation, input),
      });
      action(session, "say", { user: user.id, channel: conversation.id, ts: message.ts });
      return message;
    },

    replyAsUser(session, userId, input, thread, alsoSendToChannel) {
      const conversation = store.conversations.get(session, thread.channel);
      const user = member(session, userId, conversation);
      const root = requireMessage(conversation, thread.ts);
      const message = post(conversation, user.id, content(session, input), {
        threadTs: root.threadTs ?? root.ts,
        metadata: input.metadata,
        files: shared(user.id, conversation, input),
        broadcast: alsoSendToChannel,
      });
      action(session, "reply", {
        user: user.id,
        channel: conversation.id,
        ts: message.ts,
        broadcast: alsoSendToChannel,
      });
      return message;
    },

    postAsApp(conversation, input, options, app = store.app) {
      const text = input.text ?? "";
      return post(
        conversation,
        app.botUserId,
        // Slack gives what the app posts as text a `rich_text` block of it, as it does a person's message.
        { text, blocks: blocksOf(text, input.blocks) },
        { ...options, metadata: input.metadata },
      );
    },

    checkContent,

    edit(conversation, message, body) {
      const { team } = store;
      const apps = store.apps.all();
      const previous = messageObject(message, author(message.user), team, apps);
      Object.assign(message, { text: body.text, blocks: identified(body.blocks, () => ids.next(SLACK_IDS.block)) });
      const eventTs = slackTs(ids);
      message.edited = eventTs;
      const current = messageObject(message, author(message.user), team, apps);
      const sent = emit(
        conversation,
        messageSubscription(conversation),
        messageChangedEvent(current, previous, conversation, eventTs),
      );
      for (const one of sent) message.deliveries.push(one.id);
      return builtInDelivery(sent);
    },

    remove(conversation, message) {
      const previous = messageObject(message, author(message.user), store.team, store.apps.all());
      store.removeMessage(conversation.id, message.ts);
      emit(conversation, messageSubscription(conversation), messageDeletedEvent(previous, conversation, slackTs(ids)));
    },

    react(conversation, message, userId, emoji, direction) {
      const name = emojiName(emoji);
      const reaction = message.reactions.find((candidate) => candidate.name === name);
      if (direction === "add") {
        if (reaction?.users.includes(userId))
          throw refuse("already_reacted", `${userId} already reacted with :${name}:`);
        if (reaction) reaction.users.push(userId);
        else message.reactions.push({ name, users: [userId] });
      } else {
        if (!reaction?.users.includes(userId))
          throw refuse("no_reaction", `${userId} has no :${name}: reaction to remove`);
        reaction.users.splice(reaction.users.indexOf(userId), 1);
        if (reaction.users.length === 0) message.reactions.splice(message.reactions.indexOf(reaction), 1);
      }
      return builtInDelivery(
        emit(
          conversation,
          direction === "add" ? "reaction_added" : "reaction_removed",
          reactionEvent(direction, { user: userId, reaction: name, message, eventTs: slackTs(ids) }),
        ),
      );
    },

    editAsUser(session, userId, input, target) {
      const conversation = store.conversations.get(session, target.channel);
      const user = member(session, userId, conversation);
      const message = requireMessage(conversation, target.ts);
      if (message.user !== user.id) throw refuse("cant_update_message", "People can only edit their own messages");
      this.edit(conversation, message, content(session, input));
      action(session, "edit", { user: user.id, channel: conversation.id, ts: message.ts });
      return message;
    },

    deleteAsUser(session, userId, target) {
      const conversation = store.conversations.get(session, target.channel);
      const user = member(session, userId, conversation);
      const message = requireMessage(conversation, target.ts);
      if (message.user !== user.id && !user.isAdmin) {
        throw refuse("cant_delete_message", "People can only delete their own messages, unless they are an admin");
      }
      this.remove(conversation, message);
      action(session, "delete", { user: user.id, channel: conversation.id, ts: message.ts });
    },

    reactAsUser(session, userId, emoji, target, direction) {
      const conversation = store.conversations.get(session, target.channel);
      const user = member(session, userId, conversation);
      const message = requireMessage(conversation, target.ts);
      const delivery = this.react(conversation, message, user.id, emoji, direction);
      action(session, direction === "add" ? "react" : "unreact", {
        user: user.id,
        channel: conversation.id,
        ts: message.ts,
        emoji: emojiName(emoji),
      });
      return delivery;
    },

    join(conversation, userId, inviter) {
      conversation.members.add(userId);
      emit(
        conversation,
        "member_joined_channel",
        membershipEvent("member_joined_channel", {
          user: userId,
          conversation,
          team: store.team,
          inviter,
          eventTs: slackTs(ids),
        }),
      );
      emit(
        conversation,
        messageSubscription(conversation),
        channelMessageEvent("channel_join", { user: userId, conversation, inviter, ts: slackTs(ids) }),
      );
    },

    archive(conversation, userId) {
      conversation.isArchived = true;
      emit(
        conversation,
        messageSubscription(conversation),
        channelMessageEvent("channel_archive", { user: userId, conversation, ts: slackTs(ids) }),
      );
    },

    invite(session, userId, participants, channel) {
      const conversation = store.conversations.get(session, channel);
      const inviter = member(session, userId, conversation);
      for (const id of participants.map((candidate) => participant(session, candidate))) {
        if (conversation.members.has(id))
          throw refuse("already_in_channel", `${id} is already a member of ${conversation.id}`);
        this.join(conversation, id, inviter.id);
      }
      action(session, "invite", { user: inviter.id, channel: conversation.id });
    },

    kick(session, userId, target, channel) {
      const conversation = store.conversations.get(session, channel);
      const kicker = member(session, userId, conversation);
      const id = participant(session, target);
      if (!conversation.members.has(id)) throw refuse("not_in_channel", `${id} is not a member of ${conversation.id}`);
      // The app hears that someone left while it is still a member; once it is removed itself, it hears nothing more.
      const event = membershipEvent("member_left_channel", {
        user: id,
        conversation,
        team: store.team,
        eventTs: slackTs(ids),
      });
      if (!store.isAppUser(id)) conversation.members.delete(id);
      emit(conversation, "member_left_channel", event);
      conversation.members.delete(id);
      action(session, "kick", { user: kicker.id, channel: conversation.id, kicked: id });
    },

    conversation: (session, id) => store.conversations.get(session, id),
    conversations: (session) => {
      const newest = (conversation: SlackConversationRecord) => store.messagesIn(conversation.id).at(-1)?.ts ?? "";
      // `ts` values are fixed-width decimals, so they sort as text.
      return store.conversationsOf(session).sort((a, b) => newest(a).localeCompare(newest(b)));
    },
    users: (session) => store.usersOf(session),
    message: (session, channel, ts) => requireMessage(store.conversations.get(session, channel), ts),
    messages: (session, channel) =>
      store
        .messagesIn(store.conversations.get(session, channel).id)
        // A reply that was also sent to the channel shows there too. An ephemeral message is not
        // part of the conversation: only its recipient sees it (`ephemeral`, or a transcript read as them).
        .filter(
          (message) => (message.threadTs === undefined || message.broadcast) && message.ephemeralFor === undefined,
        ),
    replies: (session, channel, ts) =>
      store
        .messagesIn(store.conversations.get(session, channel).id)
        .filter((message) => message.threadTs === ts && message.ephemeralFor === undefined),
    user: (session, id) => store.users.get(session, id),
    thread: (session, channel, ts) => {
      const conversation = store.conversations.get(session, channel);
      const root = requireMessage(conversation, ts);
      const rootTs = root.threadTs ?? root.ts;
      return store
        .messagesIn(conversation.id)
        .filter((message) => message.ts === rootTs || message.threadTs === rootTs);
    },
    everything: (session, channel) => [...store.messagesIn(store.conversations.get(session, channel).id)],
    threadState: (session, channel, ts) => {
      const conversation = store.conversations.get(session, channel);
      const root = requireMessage(conversation, ts);
      return store.threadState(conversation.id, root.threadTs ?? root.ts);
    },
    ephemeral: (session, userId) => {
      const user = store.users.get(session, userId);
      return store
        .conversationsOf(session)
        .flatMap((conversation) => store.messagesIn(conversation.id))
        .filter((message) => message.ephemeralFor === user.id);
    },

    deliveries: deliveries.deliveries,
    delivery: deliveries.delivery,

    async retry(session, id, options) {
      const record = deliveries.delivery(session, id);
      await delay(context.timers, options.afterMs);
      // Slack repeats the same payload and says which retry this is, and why: one more than the
      // last retry this delivery had, whether Slack sent that one itself or a test did.
      const last = Math.max(
        0,
        ...record.attempts.map((attempt) => Number(attempt.requestHeaders["x-slack-retry-num"] ?? 0)),
      );
      return deliveries.redeliver(session, id, {
        headers: { "x-slack-retry-num": String(last + 1), "x-slack-retry-reason": options.reason },
      });
    },

    resend: (session, id, options) => deliveries.resend(session, id, options),

    socketConnections: () => socket.of(store.app).connections(),

    addFault(session, fault) {
      const id = `fault_${store.faults.length + 1}_${ids.next(SLACK_IDS.block)}`;
      // Dropping the socket happens once, now; the other faults stay until they are removed.
      if (fault.type === "drop_socket") {
        if (fault.delayMs > 0) {
          // A drop that is still to come is called off with its fault, and with its session.
          const cancel = context.timers.after(fault.delayMs, () => {
            store.pendingDrops.delete(id);
            for (const app of store.apps.all()) socket.of(app).drop();
          });
          store.pendingDrops.set(id, { session, cancel });
        } else for (const app of store.apps.all()) socket.of(app).drop();
      }
      if (fault.type !== "drop_socket") store.faults.push({ id, session, ...fault, type: fault.type });
      action(session, "fault", { fault: id, type: fault.type });
      return id;
    },

    removeFault(session, id) {
      const index = store.faults.findIndex((fault) => fault.id === id && fault.session === session);
      if (index !== -1) store.faults.splice(index, 1);
      const drop = store.pendingDrops.get(id);
      if (drop?.session === session) {
        drop.cancel();
        store.pendingDrops.delete(id);
      }
    },
  };

  const kit: InteractionKit = {
    context,
    store,
    deliveries,
    refuse,
    member,
    requireMessage,
    messageObject: (message) => messageObject(message, author(message.user), store.team, store.apps.all()),
    postAsApp: world.postAsApp,
    edit: world.edit,
    remove: world.remove,
    action,
    hears,
    emit: (conversation, subscription, event) => builtInDelivery(emitTo(conversation, subscription, event, store.app)),
    transport: () => socket.of(store.app).transport(),
    directMessage: (session, userId) => open(session, userId, [store.app.botUserId]),
    replyAsUser: (...args) => world.replyAsUser(...args),
  };
  const { dispatch, ...interactions } = createInteractions(kit);
  return Object.assign(world, interactions, createViews(kit, dispatch));
}
