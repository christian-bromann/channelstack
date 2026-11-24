/**
 * A reference agent: a Bolt app as a developer would write it, answering through the AI SDK with
 * the AI SDK's own mock model, so its answers are the same on every run. It has no channelstack code in it. It reads its
 * configuration from the environment (`channelstack env` prints it) and talks to whatever
 * `SLACK_API_URL` points at: the fake in tests, Slack itself when the variable is unset.
 */
import type { SayFn } from "@slack/bolt";
import { streamText } from "ai";

import { createApp, listen } from "../shared/bolt.ts";
import { answer, sendOrShorten, wantsWriting, writer } from "../shared/scripted-model.ts";
import {
  approvalBlocks,
  deployRequest,
  environmentBlocks,
  incidentOfferBlocks,
  incidentView,
  SUGGESTED_PROMPTS,
  texts,
} from "../shared/workflows.ts";

const app = createApp();

/** Events Slack delivers more than once (a retry after a slow ack) are handled once. */
const handled = new Set<string>();
const firstTime = (eventId: string) => !handled.has(eventId) && handled.add(eventId).size > 0;

/**
 * Threads the agent has answered in, and whom it is helping there: it keeps answering that
 * person's follow-ups without a new mention, and anyone's question. Someone else chiming in
 * ("+1, also need this") isn't asking it anything.
 */
const joined = new Map<string, string | undefined>();

/** Workflows first: a deploy needs an approval or an environment, an incident needs its form. True when one started. */
async function startedWorkflow(text: string, thread: string, say: SayFn): Promise<boolean> {
  const deploy = deployRequest(text);
  if (deploy?.environment) {
    const { service, environment } = deploy;
    await say({
      thread_ts: thread,
      text: texts.askApproval(service, environment),
      blocks: approvalBlocks(service, environment),
    });
    return true;
  }
  if (deploy) {
    const { service } = deploy;
    await say({
      thread_ts: thread,
      text: texts.askEnvironment(service),
      blocks: environmentBlocks(service),
    });
    return true;
  }
  if (/file an incident/i.test(text)) {
    await say({ thread_ts: thread, text: texts.askIncident, blocks: incidentOfferBlocks() });
    return true;
  }
  return false;
}

app.event("app_mention", async ({ event, body, client, say }) => {
  // Other bots don't get answers, and a retried event was already answered.
  if ("bot_id" in event || !firstTime(body.event_id)) return;
  const thread = event.thread_ts ?? event.ts;
  joined.set(`${event.channel}:${thread}`, event.user);
  if (/look at/i.test(event.text))
    await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: "eyes" });
  if (await startedWorkflow(event.text, thread, say)) return;
  // In a group DM the answer goes into the conversation itself; everywhere else, into the thread.
  const { channel } = await client.conversations.info({ channel: event.channel });
  await sendOrShorten(answer(event.text, event.user ?? ""), (text) =>
    say({ text, ...(channel?.is_mpim ? {} : { thread_ts: thread }) }),
  );
});

/** Approvals already acted on, by the message the button is on: a double click deploys once. */
const approved = new Set<string>();

app.action("approve_deploy", async ({ ack, body, action, client, respond }) => {
  await ack();
  if (body.type !== "block_actions" || action.type !== "button" || !body.message || !body.channel) return;
  const { user } = await client.users.info({ user: body.user.id });
  if (!user?.is_admin) {
    return void (await respond({ response_type: "ephemeral", replace_original: false, text: texts.mayNotApprove }));
  }
  if (approved.has(body.message.ts)) return;
  approved.add(body.message.ts);
  const [service = "", environment = ""] = (action.value ?? "").split(":");
  await client.chat.postMessage({
    channel: body.channel.id,
    thread_ts: body.message.thread_ts ?? body.message.ts,
    text: texts.deploying(service, environment),
  });
});

app.action("pick_environment", async ({ ack, body, action, client }) => {
  await ack();
  if (body.type !== "block_actions" || action.type !== "static_select" || !body.message || !body.channel) return;
  await client.chat.postMessage({
    channel: body.channel.id,
    thread_ts: body.message.thread_ts ?? body.message.ts,
    text: texts.deploying(action.block_id.replace(/^deploy:/, ""), action.selected_option.value),
  });
});

app.action("open_incident_form", async ({ ack, body, client }) => {
  await ack();
  if (body.type !== "block_actions" || !body.channel) return;
  // The trigger_id is good for three seconds: the form opens before anything else happens.
  await client.views.open({ trigger_id: body.trigger_id, view: incidentView(body.channel.id) });
});

app.view("incident", async ({ ack, view, client }) => {
  await ack();
  const severity = view.state.values.severity?.value?.selected_option?.value ?? "";
  const summary = view.state.values.summary?.value?.value ?? "";
  await client.chat.postMessage({ channel: view.private_metadata, text: texts.incidentFiled(severity, summary) });
});

app.command("/deploy", async ({ ack, command }) => {
  // "/deploy web staging": answered in the acknowledgement itself, for everyone in the channel.
  const [service = "", environment = "staging"] = command.text.split(/\s+/);
  await ack({ response_type: "in_channel", text: texts.deploying(service, environment) });
});

app.shortcut("create_ticket", async ({ ack, shortcut, client }) => {
  await ack();
  if (shortcut.type !== "message_action") return;
  await client.chat.postMessage({
    channel: shortcut.channel.id,
    thread_ts: shortcut.message.thread_ts ?? shortcut.message_ts,
    text: texts.ticketCreated,
  });
});

/** What is being written right now, by thread: Stop ends it. */
const writing = new Map<string, AbortController>();

app.event("agent_session_stopped", async ({ event }) => {
  const { channel, thread_ts: thread } = event as unknown as { channel: string; thread_ts: string };
  writing.get(`${channel}:${thread}`)?.abort();
});

/** Which channel a person is looking at while they talk to the agent in its split view, by thread. */
const lookingAt = new Map<string, string>();

app.event("assistant_thread_started", async ({ event, client }) => {
  const { channel_id: channel, thread_ts: thread, context } = event.assistant_thread;
  if (context.channel_id) lookingAt.set(`${channel}:${thread}`, context.channel_id);
  await client.assistant.threads.setSuggestedPrompts({
    channel_id: channel,
    thread_ts: thread,
    prompts: SUGGESTED_PROMPTS,
  });
});

app.event("assistant_thread_context_changed", async ({ event }) => {
  const { channel_id: channel, thread_ts: thread, context } = event.assistant_thread;
  if (context.channel_id) lookingAt.set(`${channel}:${thread}`, context.channel_id);
});

app.message(async ({ message, body, client, say }) => {
  // Only what a person newly wrote: not edits or deletes (subtypes), not bots, not retries.
  if (message.subtype !== undefined || "bot_id" in message || !firstTime(body.event_id)) return;
  const thread = message.thread_ts ?? message.ts;
  const direct = message.channel_type === "im";
  const followUp =
    message.thread_ts !== undefined &&
    joined.has(`${message.channel}:${thread}`) &&
    (joined.get(`${message.channel}:${thread}`) === message.user || (message.text ?? "").trim().endsWith("?"));
  // A mention is answered by the app_mention handler; here: DMs, and follow-ups in a thread it is part of.
  if (!direct && !followUp) return;
  if ((message.text ?? "").includes("<@") && !direct) return;
  if (!joined.has(`${message.channel}:${thread}`)) joined.set(`${message.channel}:${thread}`, message.user);
  const prompt = message.text ?? "";
  // In the split view, "this channel" is the one the person is looking at.
  const looking = lookingAt.get(`${message.channel}:${thread}`);
  if (looking !== undefined && /this channel/i.test(prompt)) {
    const { channel } = await client.conversations.info({ channel: looking });
    return void (await say({ text: texts.channelSummary(channel?.name ?? looking), thread_ts: thread }));
  }
  // A DM starts the same workflows a mention does.
  if (direct && (await startedWorkflow(prompt, thread, say))) return;
  if (!wantsWriting(prompt)) {
    return sendOrShorten(answer(prompt, message.user), (text) => say({ text, thread_ts: thread }));
  }

  // Long-form: say that it is thinking, then stream the answer as the model produces it.
  await client.assistant.threads.setStatus({ channel_id: message.channel, thread_ts: thread, status: "is thinking…" });
  const stop = new AbortController();
  writing.set(`${message.channel}:${thread}`, stop);
  const { textStream } = streamText({ model: writer(prompt), prompt, abortSignal: stop.signal });
  let stream: string | undefined;
  try {
    for await (const text of textStream) {
      // Stop ends the stream on Slack's side; nothing more is written to it.
      if (stop.signal.aborted) return;
      if (stream === undefined)
        stream = (await client.chat.startStream({ channel: message.channel, thread_ts: thread, markdown_text: text }))
          .ts;
      else await client.chat.appendStream({ channel: message.channel, ts: stream, markdown_text: text });
    }
    if (stream !== undefined && !stop.signal.aborted)
      await client.chat.stopStream({ channel: message.channel, ts: stream });
  } catch (error) {
    // Stop can land between the check above and the next append: Slack has ended the stream by then and
    // says so, sometimes before the event about it arrives.
    const stoppedByUser = (error as { data?: { error?: string } }).data?.error === "stopped_by_user";
    if (!stop.signal.aborted && !stoppedByUser) throw error;
  } finally {
    writing.delete(`${message.channel}:${thread}`);
  }
});

app.event("reaction_added", async ({ event, body, client }) => {
  // A :ticket: reaction files a ticket for the message it is on.
  if (event.reaction !== "ticket" || event.item.type !== "message" || !firstTime(body.event_id)) return;
  await client.chat.postMessage({
    channel: event.item.channel,
    thread_ts: event.item.ts,
    text: "Filed ENG-1024 for this.",
  });
});

await listen(app);
