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
import type { SocketMode } from "./socket.ts";
import type { SlackFault, SlackStore } from "./store.ts";
import { createViews } from "./views.ts";

/** Slack expects an acknowledgement within 3 seconds. */
const ACK_WINDOW_MS = 3000;
/** How far back a "stale" delivery is signed: Slack receivers reject anything older than five minutes. */
const STALE_MS = 6 * 60_000;
/** Slack's limit for a message's text. */
const MAX_TEXT_LENGTH = 40_000;

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
  /** Send an event about a conversation to the agent, if the app is subscribed, installed and a member. */
  emit(conversation: SlackConversationRecord, subscription: string, event: Record<string, unknown>): string | undefined;
  /** The user a name in a test's text refers to, in this session. */
  resolveName(session: string, name: string): string | undefined;
  /**
   * The workspace uninstalls the app: it gets `app_uninstalled` and `tokens_revoked`, then nothing
   * more, and its token stops working. Undone when the session that did it closes (decision 0006).
   */
  uninstallApp(session: string): string[];

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

export function createFakeWorld(context: DriverContext, store: SlackStore, socket: SocketMode): FakeSlackWorld {
  const { ids, clock, events } = context;
  /** Slack's deliveries: signed with the signing secret over the timestamp and the exact body. Events retry; interactions don't. */
  const deliveries = deliveryKit(context, {
    driver: "slack",
    timeoutMs: ACK_WINDOW_MS,
    retry: SLACK_RETRIES,
    sign: (secret, body, atMs) => signSlackRequest(secret, body, atMs),
    secret: () => context.secret("signingSecret"),
    staleMs: STALE_MS,
  });

  const author = (id: string): SlackUserRecord | undefined => store.users.find(id);

  const resolveName = (session: string, name: string): string | undefined => {
    if (name === store.app.name) return store.app.botUserId;
    const wanted = name.toLowerCase();
    return store
      .usersOf(session)
      .find((user) => user.name.toLowerCase() === wanted || user.displayName.toLowerCase() === wanted)?.id;
  };

  /** Sign an event and hand it to the delivery queue, for the session whose action caused it. */
  const deliver = (session: string, event: Record<string, unknown>): string | undefined => {
    // The app is reached at its request URL, or over the connection it opened (Socket Mode). With neither, nothing is sent.
    if (context.webhookUrl === undefined && socket.transport() === undefined) return undefined;
    const eventId = ids.next(SLACK_IDS.event);
    const payload = eventCallback({
      event,
      eventId,
      atMs: clock(),
      team: store.team,
      app: store.app,
      verificationToken: context.secret("verificationToken"),
    });
    deliveries.send({
      id: eventId,
      session,
      type: "event_callback",
      url: context.webhookUrl ?? "",
      transport: socket.transport,
      body: JSON.stringify(payload),
      meta: { eventType: event.type, payload },
    });
    return eventId;
  };

  /** Would the app be told about this kind of event in this conversation? */
  const hears = (conversation: SlackConversationRecord | "dm", subscription: string): boolean => {
    const { app } = store;
    // Reachable at all: at its request URL, or over the socket it opened.
    const reachable = context.webhookUrl !== undefined || socket.transport() !== undefined;
    return (
      reachable &&
      app.installed &&
      app.botEvents.includes(subscription) &&
      // The app is always a member of a DM with itself.
      (conversation === "dm" || conversation.members.has(app.botUserId))
    );
  };

  const emit: FakeSlackWorld["emit"] = (conversation, subscription, event) => {
    const session = store.conversations.owner(conversation.id);
    if (session === undefined || !hears(conversation, subscription)) return undefined;
    return deliver(session, event);
  };

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
    if (id === store.app.id || id === store.app.botUserId) return store.app.botUserId;
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
    checkContent(text, input.blocks);
    return { text, blocks: blocksOf(text, input.blocks) };
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
    const { app, team } = store;
    // Slack doesn't send `app_mention` for a DM with the app, mentioned or not: that arrives as `message.im` only.
    const mentioned =
      conversation.kind !== "im" && userId !== app.botUserId && mentionedUsers(message.text).includes(app.botUserId);
    // The mention comes first: when a message causes both, `app_mention` is the one tests look at.
    for (const [subscription, event] of [
      ...(mentioned ? ([["app_mention", appMentionEvent(message, conversation, author(userId), team)]] as const) : []),
      [messageSubscription(conversation), messageEvent(message, conversation, author(userId), team, app)] as const,
    ]) {
      const id = emit(conversation, subscription, event);
      if (id !== undefined) message.deliveries.push(id);
    }
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

  const world: Omit<
    FakeSlackWorld,
    keyof ReturnType<typeof createInteractions> | keyof ReturnType<typeof createViews>
  > = {
    team: () => store.team,
    app: () => store.app,
    emit,
    resolveName,

    uninstallApp(session) {
      const { app, team } = store;
      if (!app.installed) throw refuse("account_inactive", "The app is already uninstalled");
      const eventTs = Math.floor(clock() / 1000).toString();
      const sent = [
        ["app_uninstalled", { type: "app_uninstalled", event_ts: eventTs }],
        ["tokens_revoked", { type: "tokens_revoked", tokens: { oauth: [], bot: [app.botUserId] }, event_ts: eventTs }],
      ]
        .filter(([subscription]) => app.botEvents.includes(subscription as string))
        .map(([, event]) => deliver(session, { ...(event as Record<string, unknown>), team_id: team.id }))
        .filter((id): id is string => id !== undefined);
      app.installed = false;
      store.uninstalledBy = session;
      action(session, "uninstallApp", {});
      return sent;
    },

    createUser(session, options) {
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
      const message = post(conversation, user.id, content(session, input), { metadata: input.metadata });
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

    postAsApp(conversation, input, options) {
      const text = input.text ?? "";
      return post(
        conversation,
        store.app.botUserId,
        // Slack gives what the app posts as text a `rich_text` block of it, as it does a person's message.
        { text, blocks: blocksOf(text, input.blocks) },
        { ...options, metadata: input.metadata },
      );
    },

    checkContent,

    edit(conversation, message, body) {
      const { app, team } = store;
      const previous = messageObject(message, author(message.user), team, app);
      Object.assign(message, { text: body.text, blocks: identified(body.blocks, () => ids.next(SLACK_IDS.block)) });
      const eventTs = slackTs(ids);
      message.edited = eventTs;
      const current = messageObject(message, author(message.user), team, app);
      const id = emit(
        conversation,
        messageSubscription(conversation),
        messageChangedEvent(current, previous, conversation, eventTs),
      );
      if (id !== undefined) message.deliveries.push(id);
      return id;
    },

    remove(conversation, message) {
      const previous = messageObject(message, author(message.user), store.team, store.app);
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
      return emit(
        conversation,
        direction === "add" ? "reaction_added" : "reaction_removed",
        reactionEvent(direction, { user: userId, reaction: name, message, eventTs: slackTs(ids) }),
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

    invite(session, userId, participants, channel) {
      const conversation = store.conversations.get(session, channel);
      const inviter = member(session, userId, conversation);
      for (const id of participants.map((candidate) => participant(session, candidate))) {
        if (conversation.members.has(id))
          throw refuse("already_in_channel", `${id} is already a member of ${conversation.id}`);
        conversation.members.add(id);
        emit(
          conversation,
          "member_joined_channel",
          membershipEvent("member_joined_channel", {
            user: id,
            conversation,
            team: store.team,
            inviter: inviter.id,
            eventTs: slackTs(ids),
          }),
        );
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
      if (id !== store.app.botUserId) conversation.members.delete(id);
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

    socketConnections: () => socket.connections(),

    addFault(session, fault) {
      const id = `fault_${store.faults.length + 1}_${ids.next(SLACK_IDS.block)}`;
      // Dropping the socket happens once, now; the other faults stay until they are removed.
      if (fault.type === "drop_socket") {
        if (fault.delayMs > 0) {
          // A drop that is still to come is called off with its fault, and with its session.
          const cancel = context.timers.after(fault.delayMs, () => {
            store.pendingDrops.delete(id);
            socket.drop();
          });
          store.pendingDrops.set(id, { session, cancel });
        } else socket.drop();
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
    messageObject: (message) => messageObject(message, author(message.user), store.team, store.app),
    postAsApp: world.postAsApp,
    edit: world.edit,
    remove: world.remove,
    action,
    hears,
    emit,
    transport: socket.transport,
    directMessage: (session, userId) => open(session, userId, [store.app.botUserId]),
    replyAsUser: (...args) => world.replyAsUser(...args),
  };
  const { dispatch, ...interactions } = createInteractions(kit);
  return Object.assign(world, interactions, createViews(kit, dispatch));
}
