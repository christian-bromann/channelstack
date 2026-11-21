import type { DeliveryAttempt, DeliveryRecord } from "../../../core/delivery/index.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { randomToken } from "../../../core/secrets/index.ts";
import { signSlackRequest } from "../../../core/signing/slack.ts";
import { mentionedUsers, resolveMentions } from "../mentions.ts";
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
import type {
  SlackConversationKind,
  SlackConversationRecord,
  SlackMessageInput,
  SlackMessageRecord,
  SlackUserRecord,
  SlackWorld,
} from "../world.ts";
import type { SlackFault, SlackStore } from "./store.ts";

/** Slack expects an acknowledgement within 3 seconds. */
const ACK_WINDOW_MS = 3000;
/** How far back a "stale" delivery is signed: Slack receivers reject anything older than five minutes. */
const STALE_MS = 6 * 60_000;
/** Slack's limit for a message's text. */
const MAX_TEXT_LENGTH = 40_000;

/** A refusal with Slack's own error code, surfaced through the control API. */
function refuse(code: string, message: string, data: Record<string, unknown> = {}): ProtocolError {
  return new ProtocolError({ platform: code, status: 409 }, message, data);
}

/** What the fake `SlackWorld` adds for the provider API, where the agent acts as the app. */
export interface FakeSlackWorld extends SlackWorld {
  /** Post as the app (`chat.postMessage`). The caller has checked membership and scopes. */
  postAsApp(
    conversation: SlackConversationRecord,
    message: SlackMessageInput,
    options: { threadTs?: string | undefined; ephemeralFor?: string | undefined },
  ): SlackMessageRecord;
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
  addFault(session: string, fault: Omit<SlackFault, "id" | "session">): string;
  removeFault(session: string, id: string): void;
}

export function createFakeWorld(context: DriverContext, store: SlackStore): FakeSlackWorld {
  const { ids, clock, events, delivery } = context;

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
    if (context.webhookUrl === undefined) return undefined;
    const eventId = ids.next("slack.event");
    const payload = eventCallback({
      event,
      eventId,
      atMs: clock(),
      team: store.team,
      app: store.app,
      verificationToken: context.secret("verificationToken"),
    });
    delivery.enqueue({
      id: eventId,
      session,
      driver: "slack",
      type: "event_callback",
      url: context.webhookUrl,
      body: JSON.stringify(payload),
      sign: (body, atMs) => signSlackRequest(context.secret("signingSecret"), body, atMs),
      timeoutMs: ACK_WINDOW_MS,
      meta: { eventType: event.type, payload },
    });
    return eventId;
  };

  const emit: FakeSlackWorld["emit"] = (conversation, subscription, event) => {
    const { app } = store;
    const session = store.conversations.owner(conversation.id);
    if (session === undefined) return undefined;
    if (!app.installed || !app.botEvents.includes(subscription) || !conversation.members.has(app.botUserId)) {
      return undefined;
    }
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

  const content = (session: string, input: SlackMessageInput): { text: string; blocks: unknown[] } => {
    const text = resolveMentions(input.text ?? "", (name) => resolveName(session, name));
    if (text === "" && (input.blocks === undefined || input.blocks.length === 0)) {
      throw refuse("no_text", "A message needs text or blocks");
    }
    if (text.length > MAX_TEXT_LENGTH)
      throw refuse("msg_too_long", `A message's text is limited to ${MAX_TEXT_LENGTH} characters`);
    return { text, blocks: input.blocks ?? [richTextBlock(text, ids.next("slack.block"))] };
  };

  /** Write a message and tell the app: `message`, and `app_mention` when the text mentions it. */
  const post = (
    conversation: SlackConversationRecord,
    userId: string,
    body: { text: string; blocks: unknown[] },
    options: { threadTs?: string | undefined; ephemeralFor?: string | undefined; metadata?: unknown },
  ): SlackMessageRecord => {
    const message: SlackMessageRecord = {
      ts: ids.slackTs(conversation.id),
      conversation: conversation.id,
      user: userId,
      text: body.text,
      blocks: body.blocks,
      threadTs: options.threadTs,
      edited: undefined,
      reactions: [],
      ephemeralFor: options.ephemeralFor,
      deliveries: [],
      metadata: options.metadata,
      stream: undefined,
    };
    store.messagesIn(conversation.id).push(message);
    // An ephemeral message exists only for its recipient: Slack sends no event for it.
    if (message.ephemeralFor !== undefined) return message;
    const { app, team } = store;
    const mentioned = userId !== app.botUserId && mentionedUsers(message.text).includes(app.botUserId);
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
        id: ids.next(kind === "im" ? "slack.dm" : "slack.mpim"),
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

  return {
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
      const id = options.id === undefined ? ids.next("slack.user") : ids.reserve("slack.user", options.id);
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
        botId: options.bot === true ? ids.next("slack.bot") : undefined,
        fixedId: options.id !== undefined,
      };
      store.users.add(id, user, session);
      store.rememberUser(id, session);
      action(session, "createUser", { user: id });
      return user;
    },

    createChannel(session, options) {
      const members = new Set(options.participants.map((id) => participant(session, id)));
      const id = ids.next("slack.channel");
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
        { text, blocks: input.blocks ?? [] },
        { ...options, metadata: input.metadata },
      );
    },

    editAsUser(session, userId, input, target) {
      const conversation = store.conversations.get(session, target.channel);
      const user = member(session, userId, conversation);
      const message = requireMessage(conversation, target.ts);
      if (message.user !== user.id) throw refuse("cant_update_message", "People can only edit their own messages");
      const { app, team } = store;
      const previous = messageObject(message, author(message.user), team, app);
      Object.assign(message, content(session, input));
      const eventTs = ids.slackTs(conversation.id);
      message.edited = eventTs;
      const current = messageObject(message, author(message.user), team, app);
      const id = emit(
        conversation,
        messageSubscription(conversation),
        messageChangedEvent(current, previous, conversation, eventTs),
      );
      if (id !== undefined) message.deliveries.push(id);
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
      const previous = messageObject(message, author(message.user), store.team, store.app);
      store.removeMessage(conversation.id, message.ts);
      emit(
        conversation,
        messageSubscription(conversation),
        messageDeletedEvent(previous, conversation, ids.slackTs(conversation.id)),
      );
      action(session, "delete", { user: user.id, channel: conversation.id, ts: message.ts });
    },

    reactAsUser(session, userId, emoji, target, direction) {
      const conversation = store.conversations.get(session, target.channel);
      const user = member(session, userId, conversation);
      const message = requireMessage(conversation, target.ts);
      const name = emoji.replace(/^:|:$/g, "");
      const reaction = message.reactions.find((candidate) => candidate.name === name);
      if (direction === "add") {
        if (reaction?.users.includes(user.id))
          throw refuse("already_reacted", `${user.id} already reacted with :${name}:`);
        if (reaction) reaction.users.push(user.id);
        else message.reactions.push({ name, users: [user.id] });
      } else {
        if (!reaction?.users.includes(user.id))
          throw refuse("no_reaction", `${user.id} has no :${name}: reaction to remove`);
        reaction.users.splice(reaction.users.indexOf(user.id), 1);
        if (reaction.users.length === 0) message.reactions.splice(message.reactions.indexOf(reaction), 1);
      }
      action(session, direction === "add" ? "react" : "unreact", {
        user: user.id,
        channel: conversation.id,
        ts: message.ts,
        emoji: name,
      });
      return emit(
        conversation,
        direction === "add" ? "reaction_added" : "reaction_removed",
        reactionEvent(direction, { user: user.id, reaction: name, message, eventTs: ids.slackTs(conversation.id) }),
      );
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
            eventTs: ids.slackTs(conversation.id),
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
        eventTs: ids.slackTs(conversation.id),
      });
      if (id !== store.app.botUserId) conversation.members.delete(id);
      emit(conversation, "member_left_channel", event);
      conversation.members.delete(id);
      action(session, "kick", { user: kicker.id, channel: conversation.id, kicked: id });
    },

    conversation: (session, id) => store.conversations.get(session, id),
    message: (session, channel, ts) => requireMessage(store.conversations.get(session, channel), ts),
    messages: (session, channel) =>
      store
        .messagesIn(store.conversations.get(session, channel).id)
        .filter((message) => message.threadTs === undefined),
    replies: (session, channel, ts) =>
      store.messagesIn(store.conversations.get(session, channel).id).filter((message) => message.threadTs === ts),
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

    deliveries: (session) => delivery.list(session).filter((record) => record.request.driver === "slack"),
    delivery: (session, id) => delivery.get(session, id),

    async retry(session, id, options) {
      const record = delivery.get(session, id);
      if (options.afterMs > 0) await new Promise((resolve) => setTimeout(resolve, options.afterMs));
      // Slack repeats the same payload and says which retry this is, and why.
      return delivery.again(session, id, {
        headers: { "x-slack-retry-num": String(record.attempts.length), "x-slack-retry-reason": options.reason },
      });
    },

    resend(session, id, options) {
      const secret = options.badSignature ? randomToken() : context.secret("signingSecret");
      // Receivers reject a request more than five minutes old; six is safely outside.
      const age = options.stale ? STALE_MS : 0;
      return delivery.again(session, id, {
        sign: (body, atMs) => signSlackRequest(secret, body, atMs - age),
        forged: options.badSignature || options.stale,
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      });
    },

    addFault(session, fault) {
      const id = `fault_${store.faults.length + 1}_${ids.next("slack.block")}`;
      store.faults.push({ id, session, ...fault });
      action(session, "fault", { fault: id, type: fault.type });
      return id;
    },

    removeFault(session, id) {
      const index = store.faults.findIndex((fault) => fault.id === id && fault.session === session);
      if (index !== -1) store.faults.splice(index, 1);
    },
  };
}
