import { expect, test } from "vitest";

// Exit check 1.5: negative matchers wait for quiet. The test plays the agent itself: it posts as
// the app, through the fake Slack API, at a moment it chooses.

/** Post as the app, the way an agent does: with the bot token, against the fake's Web API. */
async function postAsApp(env: Record<string, string>, message: { channel: string; thread_ts: string; text: string }) {
  const response = await fetch(`${env.SLACK_API_URL}chat.postMessage`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(message),
  });
  expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
}

test("a reply 500 ms after a .not.toHaveReplyFrom check started makes it fail", async ({ slack, channelstack }) => {
  const env = await channelstack.env();
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  // No mention: the reference agent stays out of it, and the test decides when the app speaks.
  const msg = await ana.say("deploying now", { channel });
  await channelstack.quiet();

  const late = new Promise<void>((resolve, reject) =>
    setTimeout(
      () => postAsApp(env, { channel: channel.id, thread_ts: msg.ts, text: "too late" }).then(resolve, reject),
      500,
    ),
  );
  // The check started with nothing there. It waits for quiet, so it still sees the reply.
  await expect(expect(msg.thread).not.toHaveReplyFrom("my-agent")).rejects.toThrow(/too late/);
  await late;
});

test("a reply after the quiet window doesn't", async ({ slack, channelstack }) => {
  const env = await channelstack.env();
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  const msg = await ana.say("deploying now", { channel });
  await channelstack.quiet();

  const started = Date.now();
  const later = new Promise<void>((resolve, reject) =>
    setTimeout(
      () => postAsApp(env, { channel: channel.id, thread_ts: msg.ts, text: "much later" }).then(resolve, reject),
      1500,
    ),
  );
  await expect(msg.thread).not.toHaveReplyFrom("my-agent", { quietFor: "750ms" });
  // It didn't wait for the reply: it passed once the session had been quiet for the window.
  expect(Date.now() - started).toBeLessThan(1400);
  await later;
});
