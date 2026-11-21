/**
 * A deliberately broken reference agent. It reproduces a bug a real agent shipped with: it opens
 * its reply with "Thinking…", the model call behind it fails, and nothing ever finishes or removes
 * the reply. The person is left with a lone "Thinking…" and no answer.
 *
 * It exists so the test suite can show that channelstack catches this: the stream-and-status
 * example fails against it, and the failure names the message that was left behind.
 */
import { app, listen } from "../shared/bolt.ts";

/** The model call that goes wrong after a moment. */
const model = (): Promise<string> =>
  new Promise((_, reject) => setTimeout(() => reject(new Error("The model provider answered 529")), 700));

app.message(async ({ message, client }) => {
  if (message.subtype !== undefined || "bot_id" in message || message.channel_type !== "im") return;
  const thread = message.thread_ts ?? message.ts;
  await client.assistant.threads.setStatus({ channel_id: message.channel, thread_ts: thread, status: "is thinking…" });
  const answer = model();
  // The bug: the reply is opened before there is anything to say…
  const stream = client.chat.startStream({ channel: message.channel, thread_ts: thread, markdown_text: "Thinking…" });
  try {
    const text = await answer;
    await client.chat.appendStream({ channel: message.channel, ts: (await stream).ts ?? "", markdown_text: text });
    await client.chat.stopStream({ channel: message.channel, ts: (await stream).ts ?? "" });
  } catch {
    // …and when the model fails, the error is swallowed: the stream is never stopped.
  }
});

await listen();
