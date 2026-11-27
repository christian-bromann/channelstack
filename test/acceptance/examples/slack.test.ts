/**
 * Slack examples. Every test runs against the in-memory fake by default.
 * Tests marked "fake only" use delivery chaos or faults, which live mode doesn't support.
 */
import { describe, expect, test } from "vitest";

describe("mentions and threads", () => {
  test("a mention gets exactly one reply, in the thread", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });

    const msg = await ana.say("@my-agent summarize yesterday's incidents", { channel });

    await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /incident/i });
    await expect(msg.thread).toHaveRepliesFrom(slack.app, { count: 1 });
    await expect(channel).not.toHaveChannelMessageFrom("my-agent");
  });

  test("follow-ups in the thread are answered without a new mention", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    const msg = await ana.say("@my-agent what's the status of the web deploy?", { channel });
    await msg.thread.waitForReply({ from: "my-agent" });

    await ana.reply("and the API?", { thread: msg });

    const answer = await msg.thread.waitForReply({ from: "my-agent" });
    expect(answer.text).toMatch(/api/i);
  });

  test("a channel the app isn't in stays silent until it's invited", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana", admin: true });
    const channel = await slack.createChannel({ participants: [ana] });

    const first = await ana.say("@my-agent are you here?", { channel });
    await expect(first.thread).not.toHaveReplyFrom("my-agent");

    await ana.invite(slack.app, { channel });
    const second = await ana.say("@my-agent now?", { channel });
    await expect(second.thread).toHaveReplyFrom("my-agent");
  });

  test("it ignores its own messages and other bots", async ({ slack }) => {
    const deployBot = await slack.createUser({ name: "deploy-bot", bot: true });
    const channel = await slack.createChannel({ participants: [deployBot, slack.app] });

    const msg = await deployBot.say("@my-agent build #812 failed", { channel });

    await expect(msg.thread).not.toHaveReplyFrom("my-agent");
  });

  test("allowlisted people by fixed id", async ({ slack }) => {
    const admin = await slack.createUser({ name: "Cara", id: "U0ADMIN01" });
    const stranger = await slack.createUser({ name: "Dev" });
    const channel = await slack.createChannel({ participants: [admin, stranger, slack.app] });

    const allowed = await admin.say("@my-agent rotate the API keys", { channel });
    const refused = await stranger.say("@my-agent rotate the API keys", { channel });

    await expect(allowed.thread).toHaveReplyFrom("my-agent", { text: /rotating/i });
    await expect(refused.thread).toHaveReplyFrom("my-agent", { text: /not allowed/i });
  });
});

describe("direct messages", () => {
  test("a DM to the app gets a reply in the DM", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });

    const msg = await ana.say("what's on my plate today?", { to: slack.app });

    await expect(msg.conversation).toHaveReplyFrom("my-agent");
    await expect(msg.conversation).toHaveRepliesFrom("my-agent", { count: 1 });
  });

  test("a group DM with the app and a colleague", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const ben = await slack.createUser({ name: "Ben" });
    const dm = await ana.openDM([ben, slack.app]);

    await ana.say("@my-agent schedule a review with Ben", { channel: dm });

    const reply = await dm.waitForMessage({ from: "my-agent" });
    expect(reply.text).toContain("Ben");
  });
});

describe("buttons, menus, modals and commands", () => {
  test("approval buttons act once, even on a double click", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const ben = await slack.createUser({ name: "Ben", admin: true });
    const channel = await slack.createChannel({ participants: [ana, ben, slack.app] });
    const msg = await ana.say("@my-agent deploy web to staging", { channel });

    const ask = await msg.thread.latestReply({ from: "my-agent" });
    await expect(ask).toHaveButton("Approve");

    await ben.click("Approve", { message: ask });
    await ben.click("Approve", { message: ask });

    await expect(msg.thread).toContainText("Deploying", { count: 1 });
  });

  test("people who may not approve get an ephemeral refusal", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    const msg = await ana.say("@my-agent deploy web to production", { channel });

    await ana.click("Approve", { thread: msg.thread });

    const [refusal] = await ana.ephemeral();
    await expect(refusal).toBeEphemeralFor(ana);
    await expect(msg.thread).not.toContainText("Deploying");
  });

  test("a select menu choice", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    const msg = await ana.say("@my-agent deploy web", { channel });
    const ask = await msg.thread.latestReply({ from: "my-agent" });

    await ana.select("staging", { menu: "Environment", message: ask });

    await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /staging/ });
  });

  test("a modal: open, fill in, submit", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    const msg = await ana.say("@my-agent file an incident", { channel });

    await ana.click("Open form", { thread: msg.thread });
    const modal = await ana.waitForModal({ title: /incident/i });
    expect(await modal.values()).toHaveProperty("Severity");

    const submitted = await modal.submit({ Severity: "SEV2", Summary: "Checkout errors" });

    await expect(submitted).toBeAccepted({ within: "3s" });
    await expect(channel).toContainText("SEV2");
  });

  test("a slash command is acknowledged within 3 seconds", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });

    const command = await ana.runCommand("/deploy web staging", { channel });

    await expect(command).toBeAccepted({ within: "3s" });
    await expect(channel).toContainText(/deploying web to staging/i);
  });

  test("a message shortcut", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const ben = await slack.createUser({ name: "Ben" });
    const channel = await slack.createChannel({ participants: [ana, ben, slack.app] });
    const report = await ben.say("checkout returns 500 for EU users since 09:12", { channel });

    await ana.shortcut("create_ticket", { message: report });

    await expect(report.thread).toHaveReplyFrom("my-agent", { text: /ticket/i });
  });
});

describe("streaming, status and Stop", () => {
  test("streams a reply and shows a status while working", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const msg = await ana.say("write the release notes for 0.10", { to: slack.app });

    await expect(msg.thread).toHaveStatus("working");
    await expect(msg.thread).toHaveStatusText(/thinking/i);
    await expect(msg.thread).toHaveStreamingReplyFrom("my-agent");

    const reply = await msg.thread.latestReply({ from: "my-agent" });
    const stream = await reply.stream!.ended();
    expect(stream.state).toBe("completed");
    await expect(msg.thread).toHaveStatus("idle");
  });

  test("Stop ends the stream and the agent stays quiet", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const msg = await ana.say("write a long report on Q3", { to: slack.app });
    await expect(msg.thread).toHaveStreamingReplyFrom("my-agent");

    await ana.stop({ thread: msg });

    await expect(msg.thread).toHaveStatus("stopped");
    await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
  });

  test("the agent split view: suggested prompts and context", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const incidents = await slack.createChannel({ name: "incidents", participants: [ana, slack.app] });

    const thread = await ana.openAgentThread({ from: incidents });
    const prompts = await thread.suggestedPrompts();
    expect(prompts.map((p) => p.title)).toContain("What changed?");

    await ana.pickPrompt("What changed?", { thread });
    await expect(thread).toHaveReplyFrom("my-agent");

    const general = await slack.createChannel({ name: "general", participants: [ana, slack.app] });
    await ana.switchContext(general, { thread });
    await ana.reply("summarize this channel", { thread });
    await expect(thread).toHaveReplyFrom("my-agent", { text: /general/ });
  });
});

describe("reactions, edits and deletes", () => {
  test("acknowledges with a reaction, then answers", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    const msg = await ana.say("@my-agent look at the failed build", { channel });

    await expect(msg).toHaveReaction("eyes", { by: slack.app });
    await expect(msg.thread).toHaveReplyFrom("my-agent");
  });

  test("an emoji reaction as a trigger", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const ben = await slack.createUser({ name: "Ben" });
    const channel = await slack.createChannel({ participants: [ana, ben, slack.app] });
    const report = await ben.say("login is broken on Safari", { channel });

    await ana.react("ticket", { message: report });

    await expect(report.thread).toHaveReplyFrom("my-agent", { text: /ENG-\d+/ });
  });

  test("editing the question doesn't produce a second answer", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    const msg = await ana.say("@my-agent what's our uptime?", { channel });
    await msg.thread.waitForReply({ from: "my-agent" });

    await ana.edit("@my-agent what's our uptime this month?", { message: msg });

    await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
  });
});

describe("delivery and failures (fake only)", () => {
  test("survives Slack's 3s retry without answering twice", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    const msg = await ana.say("@my-agent hi", { channel });

    await msg.delivery!.retry({ after: "3s", reason: "http_timeout" });

    await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
  });

  test("rejects a bad signature and a stale timestamp", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const msg = await ana.say("hi", { to: slack.app });

    await msg.delivery!.resend({ badSignature: true });
    await expect(msg.delivery!).toBeRejected();

    await msg.delivery!.resend({ stale: true });
    await expect(msg.delivery!).toBeRejected();
  });

  test("backs off on rate limits and still answers", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const fault = await slack.fault({ type: "rate_limit", operation: "chat.postMessage", retryAfter: "1s", times: 1 });

    const msg = await ana.say("hi", { to: slack.app });

    await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
    await expect(slack).toHaveReceivedCall("chat.postMessage", { times: 2 });
    await fault.undo();
  });

  test("reconnects after the Socket Mode connection drops", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    await slack.fault({ type: "drop_socket" });

    const msg = await ana.say("still there?", { to: slack.app });

    await expect(msg.thread).toHaveReplyFrom("my-agent", { timeout: "20s" });
  });

  test("the uninstall is handled", async ({ slack }) => {
    const deliveries = await slack.uninstallApp();
    for (const delivery of deliveries) await expect(delivery).toBeAccepted();
  });
});

describe("inspecting what the agent did", () => {
  test("API calls and errors", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    await ana.say("@my-agent hi", { channel });

    const post = await slack.waitForCall({ operation: "chat.postMessage" });
    expect(post.responseStatus).toBe(200);
    await expect(slack).not.toHaveReceivedCall(/.*/, { error: "not_in_channel" });
    expect(await slack.calls({ error: true })).toEqual([]);
  });

  test("a transcript snapshot reads like the conversation", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const msg = await ana.say("what's 2 + 2?", { to: slack.app });
    await msg.thread.latestReply({ from: "my-agent" });

    const transcript = await msg.thread.transcript();
    expect(transcript.toString()).toMatchSnapshot();
  });
});

describe("live mode", () => {
  // With CHANNELSTACK_SLACK_BOT_TOKEN and CHANNELSTACK_SLACK_USER_ANA_TOKEN set, Ana is a real person
  // in the sandbox workspace and the same test acts on real Slack. The agent receives the
  // event from Slack itself; channelstack only acts and reads the result back.
  test.skipIf(!process.env.CHANNELSTACK_SLACK_USER_ANA_TOKEN)(
    "a real person asks the real agent",
    async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, slack.app] });

      const msg = await ana.say("@my-agent summarize #support today", { channel });

      await expect(msg.thread).toHaveReplyFrom("my-agent", { timeout: "30s" });
    },
  );

  // Button clicks have no API. Live, the browser actor clicks as Ana. The agent lets only admins
  // approve, so Ana's account must be one: live, a role the account doesn't have is refused.
  test.skipIf(!process.env.CHANNELSTACK_SLACK_USER_ANA_TOKEN)("a real click on a real button", async ({ slack }) => {
    const ana = await slack.createUser({ name: "Ana", admin: true, browser: { storageState: ".auth/ana-slack.json" } });
    const msg = await ana.say("deploy web to staging", { to: slack.app });

    await ana.click("Approve", { thread: msg.thread });

    await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /deploying/i, timeout: "30s" });
  });
});
