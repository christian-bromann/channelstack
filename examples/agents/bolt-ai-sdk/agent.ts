/**
 * A reference agent: a Bolt app as a developer would write it, answering through the AI SDK with
 * the AI SDK's own mock model, so its answers are the same on every run. It has no channelstack code in it. It reads its
 * configuration from the environment (`channelstack env` prints it) and talks to whatever
 * `SLACK_API_URL` points at: the fake in tests, Slack itself when the variable is unset.
 */
import { App, LogLevel } from "@slack/bolt";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";

const { SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_API_URL, PORT } = process.env;
if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET || !PORT) {
  throw new Error("The agent needs SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET and PORT");
}

/** People who may run privileged commands, by Slack user id. */
const ADMINS = new Set((process.env.ADMINS ?? "U0ADMIN01").split(","));

const app = new App({
  token: SLACK_BOT_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  ...(SLACK_API_URL ? { clientOptions: { slackApiUrl: SLACK_API_URL } } : {}),
  logLevel: LogLevel.ERROR,
});

/** The scripted model: the same prompt always gets the same answer. */
function answer(prompt: string, user: string): string {
  const text = prompt.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (/rotate the api keys/i.test(text))
    return ADMINS.has(user) ? "Rotating the API keys now." : "Sorry, you're not allowed to do that.";
  if (/2 \+ 2/.test(text)) return "2 + 2 is 4.";
  return `Here's what I found about "${text}".`;
}

/**
 * The model for long-form requests: the AI SDK's mock model, streaming a scripted answer in
 * pieces after a moment of "thinking", the way a real model does.
 */
function writer(prompt: string) {
  const pieces = [
    `# ${prompt.replace(/^write (the |a )?/i, "")}\n\n`,
    "- First, what changed.\n",
    "- Then, what to do about it.\n",
  ];
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: 700,
        chunkDelayInMs: 250,
        chunks: [
          { type: "text-start" as const, id: "answer" },
          ...pieces.map((delta) => ({ type: "text-delta" as const, id: "answer", delta })),
          { type: "text-end" as const, id: "answer" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: undefined },
            usage: {
              inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 24, text: 24, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  });
}

/** Events Slack delivers more than once (a retry after a slow ack) are handled once. */
const handled = new Set<string>();
const firstTime = (eventId: string) => !handled.has(eventId) && handled.add(eventId).size > 0;

/** Threads the agent has answered in: it keeps answering follow-ups there without a new mention. */
const joined = new Set<string>();

app.event("app_mention", async ({ event, body, client, say }) => {
  // Other bots don't get answers, and a retried event was already answered.
  if ("bot_id" in event || !firstTime(body.event_id)) return;
  const thread = event.thread_ts ?? event.ts;
  joined.add(`${event.channel}:${thread}`);
  if (/look at/i.test(event.text))
    await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: "eyes" });
  // In a group DM the answer goes into the conversation itself; everywhere else, into the thread.
  const { channel } = await client.conversations.info({ channel: event.channel });
  await say({ text: answer(event.text, event.user ?? ""), ...(channel?.is_mpim ? {} : { thread_ts: thread }) });
});

app.message(async ({ message, body, client, say }) => {
  // Only what a person newly wrote: not edits or deletes (subtypes), not bots, not retries.
  if (message.subtype !== undefined || "bot_id" in message || !firstTime(body.event_id)) return;
  const thread = message.thread_ts ?? message.ts;
  const direct = message.channel_type === "im";
  const followUp = message.thread_ts !== undefined && joined.has(`${message.channel}:${thread}`);
  // A mention is answered by the app_mention handler; here: DMs, and follow-ups in a thread it is part of.
  if (!direct && !followUp) return;
  if ((message.text ?? "").includes("<@") && !direct) return;
  joined.add(`${message.channel}:${thread}`);
  const prompt = message.text ?? "";
  if (!/^write /i.test(prompt)) return void (await say({ text: answer(prompt, message.user), thread_ts: thread }));

  // Long-form: say that it is thinking, then stream the answer as the model produces it.
  await client.assistant.threads.setStatus({ channel_id: message.channel, thread_ts: thread, status: "is thinking…" });
  const { textStream } = streamText({ model: writer(prompt), prompt });
  let stream: string | undefined;
  for await (const text of textStream) {
    if (stream === undefined)
      stream = (await client.chat.startStream({ channel: message.channel, thread_ts: thread, markdown_text: text })).ts;
    else await client.chat.appendStream({ channel: message.channel, ts: stream, markdown_text: text });
  }
  if (stream !== undefined) await client.chat.stopStream({ channel: message.channel, ts: stream });
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

await app.start(Number(PORT));
