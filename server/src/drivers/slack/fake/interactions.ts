import type { DeliveryTransport } from "../../../core/delivery/index.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { randomToken } from "../../../core/secrets/index.ts";
import { signSlackRequest } from "../../../core/signing/slack.ts";
import { type Block, blockControls, findButton, findSelect, identified, plain, selectOptions } from "../blocks.ts";
import {
  blockActionsPayload,
  type InteractionContext,
  messageActionPayload,
  payloadForm,
  slashCommandFields,
} from "../interaction-payloads.ts";
import {
  type Immediate,
  NOBODY,
  type SlackControlScope,
  type SlackConversationRecord,
  type SlackMessageInput,
  type SlackMessageRecord,
  type SlackUserRecord,
  type SlackWorld,
} from "../world.ts";
import type { SlackStore } from "./store.ts";

/** How long the app has to acknowledge an interaction, and to use its `trigger_id`. */
const ACK_WINDOW_MS = 3000;
/** A `response_url` works five times within 30 minutes. */
const RESPONSE_URL_USES = 5;
const RESPONSE_URL_LIFETIME_MS = 30 * 60_000;

/** What the interactions need from the rest of the fake world. */
export interface InteractionKit {
  context: DriverContext;
  store: SlackStore;
  refuse(code: string, message: string, data?: Record<string, unknown>): ProtocolError;
  /** The person, who must be in the conversation. */
  member(session: string, userId: string, conversation: SlackConversationRecord): SlackUserRecord;
  requireMessage(conversation: SlackConversationRecord, ts: string): SlackMessageRecord;
  /** A message as events and `conversations.history` show it. */
  messageObject(message: SlackMessageRecord): Record<string, unknown>;
  postAsApp(
    conversation: SlackConversationRecord,
    message: SlackMessageInput,
    options: { threadTs?: string | undefined; ephemeralFor?: string | undefined },
  ): SlackMessageRecord;
  edit(
    conversation: SlackConversationRecord,
    message: SlackMessageRecord,
    body: { text: string; blocks: unknown[] },
  ): void;
  remove(conversation: SlackConversationRecord, message: SlackMessageRecord): void;
  action(session: string, name: string, data: Record<string, unknown>): void;
  /** The person's DM with the app, opened if there is none yet. */
  directMessage(session: string, userId: string): SlackConversationRecord;
  /** A person writes in a thread. */
  replyAsUser: Immediate<SlackWorld>["replyAsUser"];
  /** The app's Socket Mode connection, once it has chosen that over a request URL. */
  transport(): DeliveryTransport | undefined;
  /** Would the app be told about this kind of event in this conversation? It must be installed, subscribed and a member. */
  hears(conversation: SlackConversationRecord | "dm", subscription: string): boolean;
  /** Send an event about a conversation to the app, if it is subscribed, installed and a member. */
  emit(conversation: SlackConversationRecord, subscription: string, event: Record<string, unknown>): string | undefined;
}

/** Sending an interaction to the app, for the parts of the fake that have their own (modals). */
export interface InteractionDispatch {
  issueTrigger(session: string, user: SlackUserRecord): string;
  /** Refuses with `dispatch_failed` when Slack has nowhere to send an interaction. Asked before anything changes. */
  reachable(): void;
  send(
    session: string,
    type: string,
    body: string,
    payload: Record<string, unknown>,
    answered?: (answer: { contentType: string; body: string }) => void,
  ): string;
}

type Interactions = Pick<
  SlackWorld,
  | "clickAsUser"
  | "selectAsUser"
  | "shortcutAsUser"
  | "commandAsUser"
  | "stopAsUser"
  | "openAgentThread"
  | "pickPrompt"
  | "switchContext"
  | "suggestedPrompts"
> & {
  dispatch: InteractionDispatch;
  /**
   * The app answers an interaction through its `response_url`. False when the URL is unknown,
   * used up or expired.
   */
  respond(key: string, body: Record<string, unknown>): boolean;
};

/** What a person does in the client beyond writing: buttons, menus, shortcuts and slash commands. */
export function createInteractions(kit: InteractionKit): Interactions {
  const { context, store, refuse, member, requireMessage } = kit;
  const { ids, clock, delivery } = context;

  /** A `trigger_id` the app may open one modal with, for three seconds. */
  const issueTrigger = (session: string, user: SlackUserRecord): string => {
    const triggerId = ids.next("slack.trigger");
    store.triggers.set(triggerId, { session, user: user.id, expiresAt: clock() + ACK_WINDOW_MS, used: false });
    return triggerId;
  };

  /** Hand the app what it needs to answer: a `trigger_id` for a modal, a `response_url` for messages. */
  const answerable = (
    session: string,
    kind: "actions" | "commands",
    user: SlackUserRecord,
    conversation: SlackConversationRecord,
    source?: SlackMessageRecord,
  ): InteractionContext => {
    const triggerId = issueTrigger(session, user);
    // The URL is the credential, as with Slack's: whoever has it may answer.
    const key = `${store.team.id}/${triggerId.split(".")[0]}/${randomToken(18)}`;
    store.responseUrls.set(key, {
      session,
      conversation: conversation.id,
      user: user.id,
      source: source?.ts,
      threadTs: source?.threadTs,
      expiresAt: clock() + RESPONSE_URL_LIFETIME_MS,
      uses: 0,
    });
    return {
      user,
      team: store.team,
      app: store.app,
      conversation,
      verificationToken: context.secret("verificationToken"),
      triggerId,
      responseUrl: `${context.apiUrl()}/hooks/${kind}/${key}`,
    };
  };

  const reachable = () => {
    if (context.webhookUrl === undefined && kit.transport() === undefined) {
      throw refuse("dispatch_failed", "The app has no request URL and no socket, so Slack has nowhere to send this");
    }
  };

  /** Sign an interaction and send it. Slack doesn't retry these: the person sees an error instead. */
  const send = (
    session: string,
    type: string,
    body: string,
    payload: Record<string, unknown>,
    answered?: (answer: { contentType: string; body: string }) => void,
  ): string => {
    reachable();
    const id = ids.next("slack.event");
    delivery.enqueue({
      id,
      session,
      driver: "slack",
      type,
      url: context.webhookUrl ?? "",
      transport: kit.transport,
      body,
      contentType: "application/x-www-form-urlencoded",
      sign: (bytes, atMs) => signSlackRequest(context.secret("signingSecret"), bytes, atMs),
      timeoutMs: ACK_WINDOW_MS,
      meta: { payload },
      ...(answered ? { answered } : {}),
    });
    return id;
  };

  /** The messages a person could find a control on, newest first. */
  const inScope = (session: string, user: SlackUserRecord, where: SlackControlScope) => {
    const reference =
      "message" in where ? where.message : "thread" in where ? where.thread : { channel: where.channel };
    const conversation = store.conversations.get(session, reference.channel);
    member(session, user.id, conversation);
    const visible = (message: SlackMessageRecord) =>
      message.ephemeralFor === undefined || message.ephemeralFor === user.id;
    if ("message" in where) {
      // A message only someone else can see isn't there for this person.
      const message = requireMessage(conversation, where.message.ts);
      if (!visible(message)) {
        throw new ProtocolError("not_found", `No message ${where.message.ts} in ${conversation.id}`);
      }
      return { conversation, messages: [message] };
    }
    const all = store.messagesIn(conversation.id).filter(visible);
    if ("channel" in where) return { conversation, messages: all.toReversed() };
    const root = requireMessage(conversation, where.thread.ts);
    const rootTs = root.threadTs ?? root.ts;
    return {
      conversation,
      messages: all.filter((message) => message.ts === rootTs || message.threadTs === rootTs).toReversed(),
    };
  };

  /** One entry of `actions`: the control as the app wrote it, with where it sits and when it was used. */
  const acted = (found: { block: Block; element: Block }, extra: object) => ({
    ...found.element,
    block_id: found.block.block_id,
    action_ts: ids.slackTs(),
    ...extra,
  });

  const blockActions = (
    session: string,
    user: SlackUserRecord,
    conversation: SlackConversationRecord,
    message: SlackMessageRecord,
    action: Record<string, unknown>,
  ) => {
    const payload = blockActionsPayload(answerable(session, "actions", user, conversation, message), {
      message: kit.messageObject(message),
      ephemeral: message.ephemeralFor !== undefined,
      actions: [action],
    });
    return send(session, "block_actions", payloadForm(payload), payload);
  };

  return {
    dispatch: { issueTrigger, reachable, send },

    clickAsUser(session, userId, button, where) {
      const user = store.users.get(session, userId);
      const { conversation, messages } = inScope(session, user, where);
      const hit = messages
        .map((message) => ({ message, found: findButton(message.blocks, button) }))
        .find(({ found }) => found !== undefined);
      if (!hit?.found) {
        const there = messages.flatMap((message) => (message.blocks as Block[]).flatMap(blockControls));
        throw new ProtocolError(
          "not_found",
          `No button ${JSON.stringify(button.label ?? button.actionId)} there. Controls there: ${there.length === 0 ? "none" : there.join(", ")}`,
        );
      }
      reachable();
      kit.action(session, "click", {
        user: user.id,
        channel: conversation.id,
        ts: hit.message.ts,
        button: plain(hit.found.element.text),
      });
      return blockActions(session, user, conversation, hit.message, acted(hit.found, {}));
    },

    selectAsUser(session, userId, options, menu, target) {
      const user = store.users.get(session, userId);
      const { conversation, messages } = inScope(session, user, { message: target });
      const [message] = messages as [SlackMessageRecord];
      const found = findSelect(message.blocks, menu);
      if (!found) {
        throw new ProtocolError("not_found", `No menu ${JSON.stringify(menu.label ?? menu.actionId)} on that message`);
      }
      const offered = selectOptions(found.element);
      const chosen = options.map((wanted) => {
        const option = offered.find((candidate) => plain(candidate.text) === wanted || candidate.value === wanted);
        if (!option) {
          throw new ProtocolError(
            "not_found",
            `The menu has no option ${JSON.stringify(wanted)}. It offers: ${offered.map((candidate) => plain(candidate.text)).join(", ")}`,
          );
        }
        return option;
      });
      const many = String(found.element.type).startsWith("multi_");
      if (!many && chosen.length !== 1) {
        throw new ProtocolError("invalid_argument", "That menu takes one option");
      }
      reachable();
      kit.action(session, "select", { user: user.id, channel: conversation.id, ts: message.ts, options: [...options] });
      return blockActions(
        session,
        user,
        conversation,
        message,
        acted(found, many ? { selected_options: chosen } : { selected_option: chosen[0] }),
      );
    },

    shortcutAsUser(session, userId, callbackId, target) {
      const user = store.users.get(session, userId);
      const { conversation, messages } = inScope(session, user, { message: target });
      const [message] = messages as [SlackMessageRecord];
      reachable();
      kit.action(session, "shortcut", { user: user.id, channel: conversation.id, ts: message.ts, callbackId });
      // A shortcut has no message of the app's to replace: an answer through its response_url is a new message.
      const payload = messageActionPayload(answerable(session, "actions", user, conversation), {
        callbackId,
        message: kit.messageObject(message),
        actionTs: ids.slackTs(),
      });
      return send(session, "message_action", payloadForm(payload), payload);
    },

    commandAsUser(session, userId, line, channel) {
      const conversation = store.conversations.get(session, channel);
      const user = member(session, userId, conversation);
      const [command = "", ...rest] = line.trim().split(/\s+/);
      if (!/^\/\S+$/.test(command)) throw new ProtocolError("invalid_argument", "A slash command starts with /");
      reachable();
      kit.action(session, "command", { user: user.id, channel: conversation.id, command });
      const fields = slashCommandFields(answerable(session, "commands", user, conversation), {
        command,
        text: rest.join(" "),
      });
      // The app may answer in the response itself: JSON with a message, or plain text.
      return send(session, "slash_command", new URLSearchParams(fields).toString(), fields, (answer) => {
        if (answer.body.trim() === "") return;
        let message: Record<string, unknown> = { text: answer.body };
        if (answer.contentType.includes("application/json")) {
          try {
            message = JSON.parse(answer.body) as Record<string, unknown>;
          } catch {
            return;
          }
        }
        publish(conversation, user.id, undefined, message);
      });
    },

    stopAsUser(session, userId, thread) {
      const conversation = store.conversations.get(session, thread.channel);
      const user = member(session, userId, conversation);
      const root = requireMessage(conversation, thread.ts);
      const rootTs = root.threadTs ?? root.ts;
      // The client only shows Stop for an app that listens for it. Refused before anything changes.
      if (!kit.hears(conversation, "agent_session_stopped")) {
        throw refuse(
          "stop_unavailable",
          "The app doesn't receive agent_session_stopped here, so there is no Stop to press",
        );
      }
      // Slack ends what is streaming in the thread, then tells the app which messages those were.
      const streaming = store
        .messagesIn(conversation.id)
        .filter(
          (message) => (message.ts === rootTs || message.threadTs === rootTs) && message.stream?.state === "open",
        );
      for (const message of streaming) {
        if (!message.stream) continue;
        message.stream.state = "stopped";
        message.stream.endedAt = clock();
      }
      store.threadState(conversation.id, rootTs).statusText = "";
      kit.action(session, "stop", { user: user.id, channel: conversation.id, ts: rootTs });
      return (
        kit.emit(conversation, "agent_session_stopped", {
          type: "agent_session_stopped",
          channel: conversation.id,
          thread_ts: rootTs,
          user: user.id,
          streaming_message_ts: streaming.map((message) => message.ts),
          event_ts: ids.slackTs(),
        }) ?? ""
      );
    },

    openAgentThread(session, userId, from) {
      const user = store.users.get(session, userId);
      const context = from === undefined ? undefined : store.conversations.get(session, from);
      // The split view belongs to an app that is installed and listening. Refused before a DM or a thread exists.
      if (!kit.hears("dm", "assistant_thread_started")) {
        throw refuse("split_view_unavailable", "The app doesn't receive assistant_thread_started");
      }
      const dm = kit.directMessage(session, user.id);
      // The thread hangs on an anchor nobody sees; what people and the app write are its replies.
      const anchor = kit.postAsApp(dm, { text: "" }, { ephemeralFor: NOBODY });
      kit.action(session, "openAgentThread", { user: user.id, channel: dm.id, ts: anchor.ts });
      kit.emit(
        dm,
        "assistant_thread_started",
        assistantThreadEvent("assistant_thread_started", user, dm, anchor.ts, context),
      );
      return anchor;
    },

    pickPrompt(session, userId, title, thread) {
      const conversation = store.conversations.get(session, thread.channel);
      // Prompts belong to the thread, whichever of its messages was named.
      const named = requireMessage(conversation, thread.ts);
      const offered = store.threadState(conversation.id, named.threadTs ?? named.ts).suggestedPrompts ?? [];
      const prompt = offered.find((known) => known.title === title);
      if (!prompt) {
        throw new ProtocolError(
          "not_found",
          `No suggested prompt "${title}" there. Suggested: ${offered.length === 0 ? "none" : offered.map((known) => known.title).join(", ")}`,
        );
      }
      return kit.replyAsUser(session, userId, { text: prompt.message }, thread, false);
    },

    switchContext(session, userId, channel, thread) {
      const dm = store.conversations.get(session, thread.channel);
      const user = member(session, userId, dm);
      const context = store.conversations.get(session, channel);
      if (!kit.hears(dm, "assistant_thread_context_changed")) {
        throw refuse("split_view_unavailable", "The app doesn't receive assistant_thread_context_changed");
      }
      kit.action(session, "switchContext", { user: user.id, channel: context.id, ts: thread.ts });
      return (
        kit.emit(
          dm,
          "assistant_thread_context_changed",
          assistantThreadEvent("assistant_thread_context_changed", user, dm, thread.ts, context),
        ) ?? ""
      );
    },

    suggestedPrompts: (session, channel, ts) => {
      const conversation = store.conversations.get(session, channel);
      return store.threadState(conversation.id, requireMessage(conversation, ts).threadTs ?? ts).suggestedPrompts ?? [];
    },

    respond(key, body) {
      const url = store.responseUrls.get(key);
      if (!url || url.uses >= RESPONSE_URL_USES || url.expiresAt < clock()) return false;
      url.uses += 1;
      const conversation = store.conversations.find(url.conversation);
      if (!conversation) return false;
      const source = url.source === undefined ? undefined : store.findMessage(conversation.id, url.source);
      // An ephemeral message was never the app's to hear about: it changes or goes without an event.
      const quietly = source?.ephemeralFor !== undefined;
      if (body.delete_original === true) {
        if (source && quietly) store.removeMessage(conversation.id, source.ts);
        else if (source) kit.remove(conversation, source);
        return true;
      }
      // An answer replaces the message the control was on, unless it says otherwise or there is none.
      if (source && body.replace_original !== false) {
        const text = typeof body.text === "string" ? body.text : "";
        const blocks = Array.isArray(body.blocks) ? body.blocks : [];
        if (quietly) Object.assign(source, { text, blocks: identified(blocks, () => ids.next("slack.block")) });
        else kit.edit(conversation, source, { text, blocks });
        return true;
      }
      publish(conversation, url.user, url.threadTs, body);
      return true;
    },
  };

  /** `assistant_thread_started` and `assistant_thread_context_changed`: who has the view open, where, looking at what. */
  function assistantThreadEvent(
    type: string,
    user: SlackUserRecord,
    dm: SlackConversationRecord,
    threadTs: string,
    looking: SlackConversationRecord | undefined,
  ): Record<string, unknown> {
    return {
      type,
      assistant_thread: {
        user_id: user.id,
        context: { ...(looking ? { channel_id: looking.id } : {}), team_id: store.team.id, enterprise_id: null },
        channel_id: dm.id,
        thread_ts: threadTs,
      },
      event_ts: ids.slackTs(),
    };
  }

  /** A new message from the app in answer to an interaction: for the person alone, unless it is `in_channel`. */
  function publish(
    conversation: SlackConversationRecord,
    userId: string,
    threadTs: string | undefined,
    body: Record<string, unknown>,
  ): void {
    const text = typeof body.text === "string" ? body.text : "";
    const blocks = Array.isArray(body.blocks) ? body.blocks : undefined;
    if (text === "" && blocks === undefined) return;
    kit.postAsApp(
      conversation,
      { text, ...(blocks ? { blocks } : {}) },
      {
        threadTs: typeof body.thread_ts === "string" ? body.thread_ts : threadTs,
        ...(body.response_type === "in_channel" ? {} : { ephemeralFor: userId }),
      },
    );
  }
}
