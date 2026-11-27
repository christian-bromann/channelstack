/**
 * OpenAI examples (decision 0029). The agent is a Slack app on the official `openai` SDK or the AI
 * SDK, pointed at the fake OpenAI by `OPENAI_BASE_URL` from `channelstack env`. Every test scripts
 * the model with `openai.respond(…)`; none needs a key, and an unscripted call fails the test.
 */
import { describe, expect, test } from "vitest";

describe("scripting the model", () => {
  test("a tool loop ends in one answer, in the thread", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    const ai = await openai.respond([
      { toolCalls: [{ name: "search_incidents", arguments: { since: "yesterday" } }] },
      "Two incidents yesterday: the web deploy and a DNS blip.",
    ]);

    const msg = await ana.say("@my-agent what broke yesterday?", { channel });

    await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /DNS blip/ });
    await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
    await expect(ai).toHaveAnswered({ times: 2 });
    const [search] = await ai.toolCalls();
    expect(search?.result?.text).toMatch(/migration/); // the agent ran the tool and sent the result back
  });

  test("the answer is computed from what the agent sent", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    await openai.respond(
      (request) =>
        `I can see ${request.messages.filter((message) => message.role === "user").length} messages from you.`,
    );

    const msg = await ana.say("@my-agent the deploy failed", { channel });
    await msg.thread.waitForReply({ from: "my-agent" });
    await ana.reply("it's the migration step", { thread: msg });

    // The second answer proves the agent sent the whole thread, not only the newest message.
    await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /2 messages/ });
  });
});

describe("timing and failures (fake only)", () => {
  test("a slow model and Slack's 3s retry still give one reply", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    await openai.respond("Here's the summary.", { timing: { firstToken: "5s" } });

    const msg = await ana.say("summarize #support today", { to: slack.app });
    await msg.delivery!.retry({ after: "3s", reason: "http_timeout" });

    await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1, timeout: "15s" });
    await expect(openai).toHaveReceivedCall(/chat\.completions|responses/, { times: 1 });
  });

  test("a stream that breaks halfway is finalised, and the status clears", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    await openai.respond({
      text: ["The deploy", " failed at", " the migration", " step because"],
      timing: { betweenChunks: "100ms" },
      failAfter: { chunks: 2, how: "drop" },
    });

    const msg = await ana.say("why did the deploy fail?", { to: slack.app });

    await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /deploy failed at/ });
    await expect(msg.thread).not.toHaveStreamingReplyFrom("my-agent");
    await expect(msg.thread).toHaveStatus("idle");
  });

  test("overloaded twice: the SDK retries, and the person gets one answer", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    await openai.respond([{ error: "overloaded" }, { error: "overloaded" }, "All good now."]);

    const msg = await ana.say("status?", { to: slack.app });

    await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /All good now/ });
    await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
    await expect(openai).toHaveReceivedCall(/chat\.completions|responses/, { times: 3 });
  });

  test("Stop cancels the model request", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const ai = await openai.respond({ text: "A long answer ".repeat(40), pauseAfter: 3 });

    const msg = await ana.say("write me a long report", { to: slack.app });
    const call = await ai.waitForPause();
    await ana.stop({ thread: msg });

    await expect(msg.thread).toHaveStatus("stopped");
    await expect(call).toBeAborted();
  });
});

describe("several calls at once", () => {
  // The agents send the Slack user id as `user`, so each call's context names its person.
  test("two people ask at once; each gets the answer to their own question", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const ben = await slack.createUser({ name: "Ben" });
    const channel = await slack.createChannel({ participants: [ana, ben, slack.app] });
    await openai.respond((request) =>
      request.context.from?.id === ana.id ? "Your deploy is green." : "Your migration is still running.",
    );

    const [a, b] = await Promise.all([
      ana.say("@my-agent how's my change doing?", { channel }),
      ben.say("@my-agent how's my change doing?", { channel }),
    ]);

    await expect(a.thread).toHaveReplyFrom("my-agent", { text: /deploy is green/ });
    await expect(b.thread).toHaveReplyFrom("my-agent", { text: /migration/ });
  });
});

describe("what the agent sends the model", () => {
  test("thread history, no private-channel text, no secrets", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const ben = await slack.createUser({ name: "Ben" });
    const secret = await slack.createChannel({ private: true, participants: [ben, slack.app] });
    const leak = await ben.say("the acquisition closes on Friday", { channel: secret });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    await openai.respond("Noted.", { times: -1 });

    const first = await ana.say("@my-agent the deploy failed", { channel });
    await first.thread.waitForReply({ from: "my-agent" });
    const second = await ana.reply("it's the migration step", { thread: first });
    await first.thread.waitForReply({ from: "my-agent" });

    const call = await openai.latestCall();
    await expect(call).toHaveSent([first, second], { ordered: true });
    await expect(openai).not.toHaveSent(leak);
    await expect(openai).not.toHaveSentSecrets();
  });
});

describe("a missing script fails the test", () => {
  test("plan limits: the agent tells the person, once", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    await openai.respond({ error: "project_spend_limit_exceeded", shouldRetry: false }, { times: -1 });

    const msg = await ana.say("summarize #support", { to: slack.app });

    await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /isn't answering/ });
    await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
  });
});
