/**
 * A reference agent: a Slack bot on the Chat SDK as a developer would write it, answering through
 * the AI SDK with the AI SDK's own mock model, so its answers are the same on every run. It behaves
 * like the Bolt reference agent, on a different framework, and has no channelstack code in it. It
 * reads its configuration from the environment (`channelstack env` prints it): the Slack adapter
 * picks up `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and `SLACK_API_URL` by itself.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";

import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { streamText } from "ai";
import {
  Actions,
  Button,
  Card,
  CardText as Text,
  Chat,
  type Message,
  Modal,
  Select,
  SelectOption,
  TextInput,
  type Thread,
} from "chat";

import { answer, sendOrShorten, wantsWriting, writer } from "../shared/scripted-model.ts";
import { deployRequest, SUGGESTED_PROMPTS, texts } from "../shared/workflows.ts";

const { SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, PORT } = process.env;
if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET || !PORT) {
  throw new Error("The agent needs SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET and PORT");
}

// Agent messaging: every message a person sends in the DM starts its own thread, and the answer goes there.
const slack = createSlackAdapter({ agentView: true });
const bot = new Chat({
  userName: "my-agent",
  adapters: { slack },
  state: createMemoryState(),
  logger: "warn",
});

/** Which channel a person is looking at while they talk to the agent in its split view, by thread. */
const lookingAt = new Map<string, string>();

/** The workflows a mention can start: a deploy that needs an approval or an environment, the incident form. */
async function startedWorkflow(thread: Thread, message: Message): Promise<boolean> {
  const deploy = deployRequest(message.text);
  if (deploy?.environment) {
    const { service, environment } = deploy;
    await thread.post(
      Card({
        children: [
          Text(texts.askApproval(service, environment)),
          Actions([
            Button({ id: "approve_deploy", label: "Approve", style: "primary", value: `${service}:${environment}` }),
          ]),
        ],
      }),
    );
    return true;
  }
  if (deploy) {
    const options = ["staging", "production"].map((name) =>
      SelectOption({ label: name, value: `${deploy.service}:${name}` }),
    );
    await thread.post(
      Card({
        children: [
          Text(texts.askEnvironment(deploy.service)),
          Actions([Select({ id: "pick_environment", label: "Environment", placeholder: "Environment", options })]),
        ],
      }),
    );
    return true;
  }
  if (/file an incident/i.test(message.text)) {
    await thread.post(
      Card({
        children: [Text(texts.askIncident), Actions([Button({ id: "open_incident_form", label: "Open form" })])],
      }),
    );
    return true;
  }
  return false;
}

async function respond(thread: Thread, message: Message): Promise<void> {
  // Other bots don't get answers.
  if (message.author.isBot === true) return;
  // In the split view, "this channel" is the one the person is looking at.
  const looking = lookingAt.get(thread.id);
  if (looking !== undefined && /this channel/i.test(message.text)) {
    const { channel } = await slack.webClient.conversations.info({ channel: looking });
    return void (await thread.post(texts.channelSummary(channel?.name ?? looking)));
  }
  if (wantsWriting(message.text)) {
    // Long-form: say that it is thinking, then stream the answer as the model produces it.
    await thread.startTyping("is thinking…");
    const { textStream } = streamText({ model: writer(message.text), prompt: message.text });
    await thread.post(textStream);
    return;
  }
  await sendOrShorten(answer(message.text, message.author.userId), (text) => thread.post(text));
}

bot.onNewMention(async (thread, message) => {
  if (message.author.isBot === true) return;
  // It keeps answering follow-ups in this thread without a new mention.
  await thread.subscribe();
  if (/look at/i.test(message.text)) await slack.addReaction(thread.id, message.id, "eyes");
  // In a group DM the answer goes into the conversation itself; everywhere else, into the thread.
  const { channel } = await slack.webClient.conversations.info({ channel: thread.channelId.split(":").at(-1) ?? "" });
  if (channel?.is_mpim) await thread.channel.post(answer(message.text, message.author.userId));
  else if (!(await startedWorkflow(thread, message))) await respond(thread, message);
});

/** Approvals already acted on, by the message the button is on: a double click deploys once. */
const approved = new Set<string>();

bot.onAction("approve_deploy", async (event) => {
  if (!event.thread) return;
  const { user } = await slack.webClient.users.info({ user: event.user.userId });
  if (!user?.is_admin) {
    return void (await event.thread.postEphemeral(event.user, texts.mayNotApprove, { fallbackToDM: false }));
  }
  if (approved.has(event.messageId)) return;
  approved.add(event.messageId);
  const [service = "", environment = ""] = (event.value ?? "").split(":");
  await event.thread.post(texts.deploying(service, environment));
});

bot.onAction("pick_environment", async (event) => {
  const [service = "", environment = ""] = (event.value ?? "").split(":");
  await event.thread?.post(texts.deploying(service, environment));
});

bot.onAction("open_incident_form", async (event) => {
  // The trigger is good for three seconds: the form opens before anything else happens.
  await event.openModal(
    Modal({
      callbackId: "incident",
      title: "File an incident",
      submitLabel: "File",
      children: [
        Select({
          id: "severity",
          label: "Severity",
          options: ["SEV1", "SEV2", "SEV3"].map((name) => SelectOption({ label: name, value: name })),
        }),
        TextInput({ id: "summary", label: "Summary" }),
      ],
    }),
  );
});

bot.onModalSubmit("incident", async (event) => {
  const { severity = "", summary = "" } = event.values;
  // Announced in the channel the form was opened from.
  await event.relatedThread?.channel.post(texts.incidentFiled(severity, summary));
});

bot.onSlashCommand("/deploy", async (event) => {
  // "/deploy web staging"
  const [service = "", environment = "staging"] = event.text.split(/\s+/);
  await event.channel.post(texts.deploying(service, environment));
});

bot.onAssistantThreadStarted(async (event) => {
  if (event.context.channelId) lookingAt.set(event.threadId, event.context.channelId);
  await slack.setSuggestedPrompts(event.channelId, event.threadTs, SUGGESTED_PROMPTS);
});

bot.onAssistantContextChanged((event) => {
  if (event.context.channelId) lookingAt.set(event.threadId, event.context.channelId);
});

bot.onDirectMessage(respond);

bot.onSubscribedMessage(async (thread, message) => {
  // A new mention in a thread it is part of gets the same treatment as the first one.
  if (message.isMention && /look at/i.test(message.text)) await slack.addReaction(thread.id, message.id, "eyes");
  await respond(thread, message);
});

bot.onReaction(async (event) => {
  // A :ticket: reaction files a ticket for the message it is on.
  if (!event.added || event.rawEmoji !== "ticket") return;
  await event.thread.post("Filed ENG-1024 for this.");
});

/** Slack's request signature: an HMAC over the timestamp and the exact body, no older than five minutes. */
function signedBySlack(headers: IncomingHttpHeaders, body: string): boolean {
  const timestamp = String(headers["x-slack-request-timestamp"] ?? "");
  const expected = `v0=${createHmac("sha256", SLACK_SIGNING_SECRET ?? "")
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  const given = String(headers["x-slack-signature"] ?? "");
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  return fresh && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * Message shortcuts aren't something the Chat SDK handles, so this one is answered next to it:
 * "Create ticket" on a message files a ticket and says so in that message's thread.
 */
async function shortcut(headers: IncomingHttpHeaders, body: string): Promise<Response | undefined> {
  if (!String(headers["content-type"]).includes("form")) return undefined;
  const payload = new URLSearchParams(body).get("payload");
  if (!payload?.includes('"message_action"')) return undefined;
  if (!signedBySlack(headers, body)) return new Response("bad signature", { status: 401 });
  const action = JSON.parse(payload) as {
    type: string;
    callback_id: string;
    channel: { id: string };
    message: { ts: string; thread_ts?: string };
  };
  if (action.type !== "message_action" || action.callback_id !== "create_ticket") return undefined;
  await slack.webClient.chat.postMessage({
    channel: action.channel.id,
    thread_ts: action.message.thread_ts ?? action.message.ts,
    text: texts.ticketCreated,
  });
  return new Response("", { status: 200 });
}

// The Chat SDK speaks web-standard Request and Response; this is the smallest server around it.
createServer(async (incoming, outgoing) => {
  let body = "";
  for await (const chunk of incoming) body += chunk;
  const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
    method: incoming.method ?? "GET",
    headers: incoming.headers as Record<string, string>,
    ...(incoming.method === "POST" ? { body } : {}),
  });
  const response =
    incoming.url === "/slack/events"
      ? ((await shortcut(incoming.headers, body)) ?? (await bot.webhooks.slack(request)))
      : new Response("not found", { status: 404 });
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}).listen(Number(PORT), "127.0.0.1");
