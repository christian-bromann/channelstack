/**
 * An agent with one switchable fault per standard check. With `BROKEN` unset it does everything
 * right; with `BROKEN=slack.dm-once` (any check id) it has exactly the bug that check exists to
 * catch. The test suite uses it to prove that each check fails when it should.
 *
 * `REMOVES_BUTTON=1` is not a fault: the agent then replaces the approval question once it has
 * acted, the usual way to make a second click impossible. The checks must pass for it too.
 */
import { createApp, listen } from "../shared/bolt.ts";
import { answer, sendOrShorten, wantsWriting } from "../shared/scripted-model.ts";
import { approvalBlocks, deployRequest, texts } from "../shared/workflows.ts";

const fault = process.env.BROKEN ?? "";
const broken = (check: string) => fault === check;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const app = createApp({
  // Bug: trusts whoever posts to its endpoint.
  signatureVerification: !broken("slack.bad-signature"),
  // Bug: does its work before it acknowledges, and the work is slow.
  processBeforeResponse: broken("slack.ack"),
});

const seen = new Set<string>();
/** Is this event new? A retry or a redelivery of one already handled is not. */
function fresh(eventId: string, retryNum: number | undefined): boolean {
  // Bug: counts a retry as a new event.
  const key = broken("slack.retry") ? `${eventId}:${retryNum ?? 0}` : eventId;
  // Bug: only knows a repeat by its retry header, which a plain redelivery doesn't have.
  if (broken("slack.redelivery")) return retryNum === undefined;
  return !seen.has(key) && seen.add(key).size > 0;
}

type Say = (message: { text: string; thread_ts?: string; blocks?: unknown[] }) => Promise<unknown>;

/** Answer a prompt in a thread. */
async function reply(prompt: string, user: string, say: Say, thread: string, times = 1): Promise<void> {
  for (let count = 0; count < times; count++) {
    const send = (text: string) => say({ text, thread_ts: thread });
    // Bug: gives up when Slack refuses the message as too long.
    if (broken("slack.msg-too-long")) await send(answer(prompt, user)).catch(() => {});
    else await sendOrShorten(answer(prompt, user), send);
  }
}

app.event("app_mention", async ({ event, body, context, say }) => {
  // Bug: answers other bots.
  if ("bot_id" in event && !broken("slack.ignores-bots")) return;
  if (!fresh(body.event_id, context.retryNum)) return;
  if (broken("slack.ack")) await pause(3500);
  const deploy = deployRequest(event.text);
  if (deploy?.environment) {
    const { service, environment } = deploy;
    return void (await say({
      thread_ts: event.thread_ts ?? event.ts,
      text: texts.askApproval(service, environment),
      blocks: approvalBlocks(service, environment),
    }));
  }
  // Bug: answers in the channel instead of the thread.
  if (broken("slack.in-thread")) return void (await say({ text: answer(event.text, event.user ?? "") }));
  // Bug: answers a mention twice.
  await reply(
    event.text,
    event.user ?? "",
    say as Say,
    event.thread_ts ?? event.ts,
    broken("slack.mention-once") ? 2 : 1,
  );
});

/** Threads where someone pressed Stop. */
const stopped = new Set<string>();
app.event("agent_session_stopped", async ({ event }) => {
  const { channel, thread_ts: thread } = event as unknown as { channel: string; thread_ts: string };
  stopped.add(`${channel}:${thread}`);
});

app.message(async ({ message, body, context, client, say }) => {
  if (message.subtype !== undefined || message.channel_type !== "im") return;
  if ("bot_id" in message && !broken("slack.ignores-bots")) return;
  if (!fresh(body.event_id, context.retryNum)) return;
  if (broken("slack.ack")) await pause(3500);
  const thread = message.thread_ts ?? message.ts;
  const prompt = message.text ?? "";
  // Bug: answers a DM twice.
  if (!wantsWriting(prompt)) return reply(prompt, message.user, say as Say, thread, broken("slack.dm-once") ? 2 : 1);

  // Long-form: a stream that grows for a few seconds.
  const key = `${message.channel}:${thread}`;
  const pieces = Array.from({ length: 12 }, (_, index) => `Part ${index + 1} of the report. `.repeat(8));
  const started = await client.chat.startStream({
    channel: message.channel,
    thread_ts: thread,
    markdown_text: pieces[0] ?? "",
  });
  for (const piece of pieces.slice(1)) {
    await pause(250);
    if (stopped.has(key)) {
      // Bug: Stop ended the stream, so it posts the rest as a new message instead.
      if (broken("slack.stop")) await say({ text: pieces.join(""), thread_ts: thread });
      return;
    }
    await client.chat
      .appendStream({ channel: message.channel, ts: started.ts ?? "", markdown_text: piece })
      .catch(() => {});
  }
  // Bug: never finishes the stream.
  if (broken("slack.stream-stop")) return;
  await client.chat.stopStream({ channel: message.channel, ts: started.ts ?? "" }).catch(() => {});
});

const approved = new Set<string>();
app.action("approve_deploy", async ({ ack, body, action, client, respond }) => {
  await ack();
  if (body.type !== "block_actions" || action.type !== "button" || !body.message || !body.channel) return;
  const { user } = await client.users.info({ user: body.user.id });
  // Bug: lets anyone approve.
  if (!user?.is_admin && !broken("slack.click-unauthorized")) {
    return void (await respond({ response_type: "ephemeral", replace_original: false, text: texts.mayNotApprove }));
  }
  // Bug: acts on every click.
  if (approved.has(body.message.ts) && !broken("slack.double-click")) return;
  approved.add(body.message.ts);
  const [service = "", environment = ""] = (action.value ?? "").split(":");
  if (process.env.REMOVES_BUTTON === "1") await respond({ replace_original: true, text: texts.approved });
  await client.chat.postMessage({
    channel: body.channel.id,
    thread_ts: body.message.thread_ts ?? body.message.ts,
    text: texts.deploying(service, environment),
  });
});

await listen(app);
