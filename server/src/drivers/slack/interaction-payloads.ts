/**
 * Builders for what Slack sends when a person acts in the client: a button or a menu
 * (`block_actions`), a message shortcut (`message_action`) and a slash command. The first two
 * travel as a form with one `payload` field holding JSON; a command is plain form fields.
 */
import type { SlackAppRecord, SlackConversationRecord, SlackTeam, SlackUserRecord } from "./world.ts";

/** A person's handle, as Slack's `name` / `username` fields carry it. */
export const handleOf = (user: SlackUserRecord): string => user.name.toLowerCase().replace(/\s+/g, ".");

/** What every interaction payload says about who acted, where, and how to answer. */
export interface InteractionContext {
  user: SlackUserRecord;
  team: SlackTeam;
  app: SlackAppRecord;
  conversation: SlackConversationRecord;
  verificationToken: string;
  triggerId: string;
  responseUrl: string;
}

const base = ({ user, team, app, conversation, verificationToken, triggerId, responseUrl }: InteractionContext) => ({
  user: { id: user.id, username: handleOf(user), name: handleOf(user), team_id: team.id },
  api_app_id: app.id,
  token: verificationToken,
  trigger_id: triggerId,
  team: { id: team.id, domain: team.domain },
  enterprise: null,
  is_enterprise_install: false,
  channel: { id: conversation.id, name: conversation.name ?? "directmessage" },
  response_url: responseUrl,
});

/** A click on a button or a choice in a menu, in a message. `message` is the message as `conversations.history` shows it. */
export function blockActionsPayload(
  context: InteractionContext,
  input: { message: Record<string, unknown>; actions: Array<Record<string, unknown>> },
): Record<string, unknown> {
  const { message } = input;
  return {
    type: "block_actions",
    ...base(context),
    container: {
      type: "message",
      message_ts: message.ts,
      channel_id: context.conversation.id,
      is_ephemeral: false,
      ...(message.thread_ts === undefined ? {} : { thread_ts: message.thread_ts }),
    },
    message,
    state: { values: {} },
    actions: input.actions,
  };
}

/** A message shortcut run on a message. */
export function messageActionPayload(
  context: InteractionContext,
  input: { callbackId: string; message: Record<string, unknown>; actionTs: string },
): Record<string, unknown> {
  return {
    type: "message_action",
    ...base(context),
    callback_id: input.callbackId,
    action_ts: input.actionTs,
    message_ts: input.message.ts,
    message: input.message,
  };
}

/** A slash command: `/deploy web staging` is the command `/deploy` with the text `web staging`. */
export function slashCommandFields(
  { user, team, app, conversation, verificationToken, triggerId, responseUrl }: InteractionContext,
  input: { command: string; text: string },
): Record<string, string> {
  return {
    token: verificationToken,
    team_id: team.id,
    team_domain: team.domain,
    channel_id: conversation.id,
    channel_name: conversation.name ?? "directmessage",
    user_id: user.id,
    user_name: handleOf(user),
    command: input.command,
    text: input.text,
    api_app_id: app.id,
    is_enterprise_install: "false",
    response_url: responseUrl,
    trigger_id: triggerId,
  };
}

/** A payload as Slack posts it for interactions: one form field, `payload`, holding the JSON. */
export const payloadForm = (payload: Record<string, unknown>): string =>
  new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
