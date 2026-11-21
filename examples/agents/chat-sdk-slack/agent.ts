/**
 * A reference agent: a Slack bot on the Chat SDK as a developer would write it, answering through
 * the AI SDK with the AI SDK's own mock model, so its answers are the same on every run. It behaves
 * like the Bolt reference agent, on a different framework, and has no channelstack code in it. It
 * reads its configuration from the environment (`channelstack env` prints it): the Slack adapter
 * picks up `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and `SLACK_API_URL` by itself.
 */
import { createServer } from "node:http";
import { Readable } from "node:stream";

import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { streamText } from "ai";
import { Chat, type Message, type Thread } from "chat";

import { answer, wantsWriting, writer } from "../shared/scripted-model.ts";

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

async function respond(thread: Thread, message: Message): Promise<void> {
  // Other bots don't get answers.
  if (message.author.isBot === true) return;
  if (wantsWriting(message.text)) {
    // Long-form: say that it is thinking, then stream the answer as the model produces it.
    await thread.startTyping("is thinking…");
    const { textStream } = streamText({ model: writer(message.text), prompt: message.text });
    await thread.post(textStream);
    return;
  }
  await thread.post(answer(message.text, message.author.userId));
}

bot.onNewMention(async (thread, message) => {
  if (message.author.isBot === true) return;
  // It keeps answering follow-ups in this thread without a new mention.
  await thread.subscribe();
  if (/look at/i.test(message.text)) await slack.addReaction(thread.id, message.id, "eyes");
  // In a group DM the answer goes into the conversation itself; everywhere else, into the thread.
  const { channel } = await slack.webClient.conversations.info({ channel: thread.channelId.split(":").at(-1) ?? "" });
  if (channel?.is_mpim) await thread.channel.post(answer(message.text, message.author.userId));
  else await respond(thread, message);
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

// The Chat SDK speaks web-standard Request and Response; this is the smallest server around it.
createServer(async (incoming, outgoing) => {
  const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
    method: incoming.method ?? "GET",
    headers: incoming.headers as Record<string, string>,
    ...(incoming.method === "POST" ? { body: Readable.toWeb(incoming) as ReadableStream, duplex: "half" } : {}),
  });
  const response =
    incoming.url === "/slack/events" ? await bot.webhooks.slack(request) : new Response("not found", { status: 404 });
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}).listen(Number(PORT), "127.0.0.1");
