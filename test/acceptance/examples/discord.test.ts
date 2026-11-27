/**
 * Discord examples. Every test runs against the in-memory fake by default. The agent is a bot in
 * the guild: it hears people over the Gateway and answers through REST; slash commands and buttons
 * reach it as interactions. Tests marked "fake only" use delivery chaos or faults, which live mode
 * doesn't support.
 */
import { describe, expect, test } from "vitest";

describe("messages and threads", () => {
  test("a mention gets exactly one reply", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    const channel = await discord.createChannel({ participants: [ana, discord.app] });

    const msg = await ana.say("@my-agent summarize yesterday's incidents", { channel });

    await expect(msg).toHaveReplyFrom("my-agent", { text: /incidents/i });
    await expect(msg).toHaveRepliesFrom(discord.app, { count: 1 });
  });

  test("a reply to the agent's answer is answered without a new mention", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    const channel = await discord.createChannel({ participants: [ana, discord.app] });
    const msg = await ana.say("@my-agent what's the status of the web deploy?", { channel });
    const answer = await msg.waitForReply({ from: "my-agent" });

    const followUp = await ana.reply("and the API?", { message: answer });

    await expect(followUp).toHaveReplyFrom("my-agent", { text: /api/i });
  });

  test("a channel the bot can't see stays silent until it's invited", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana", admin: true });
    const channel = await discord.createChannel({ participants: [ana] });

    const first = await ana.say("@my-agent are you here?", { channel });
    await expect(first).not.toHaveReplyFrom("my-agent");

    await ana.invite(discord.app, { channel });
    const second = await ana.say("@my-agent now?", { channel });
    await expect(second).toHaveReplyFrom("my-agent");
  });

  test("it ignores other bots", async ({ discord }) => {
    const deployBot = await discord.createUser({ name: "deploy-bot", bot: true });
    const channel = await discord.createChannel({ participants: [deployBot, discord.app] });

    const msg = await deployBot.say("@my-agent build #812 failed", { channel });

    await expect(msg).not.toHaveReplyFrom("my-agent");
  });

  test("in a thread a person started, the agent answers there", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    const channel = await discord.createChannel({ participants: [ana, discord.app] });
    const report = await ana.say("checkout returns 500 for EU users", { channel });
    const thread = await ana.startThread("Checkout 500s", { message: report });

    await ana.say("@my-agent what changed in checkout?", { channel: thread });

    await expect(thread).toHaveReplyFrom("my-agent", { text: /checkout/i });
    await expect(channel).not.toHaveChannelMessageFrom("my-agent");
  });

  test("a long answer goes into a thread, each message under 2000 characters", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    const channel = await discord.createChannel({ participants: [ana, discord.app] });

    const msg = await ana.say("@my-agent write a long report on Q3", { channel });

    const first = await msg.waitForReply({ from: "my-agent" });
    expect(first.channel.kind).toBe("public_thread");
    await msg.latestReply({ from: "my-agent" });
    const replies = await msg.replies();
    expect(replies.length).toBeGreaterThan(1);
    for (const reply of replies) expect(reply.content.length).toBeLessThanOrEqual(2000);
    await expect(discord).not.toHaveReceivedCall(/.*/, { error: "50035" });
  });
});

describe("direct messages", () => {
  test("a DM to the bot gets a reply in the DM", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });

    const msg = await ana.say("what's on my plate today?", { to: discord.app });

    await expect(msg.channel).toHaveReplyFrom("my-agent");
    await expect(msg.channel).toHaveRepliesFrom("my-agent", { count: 1 });
  });
});

describe("slash commands and buttons", () => {
  test("a slash command is answered within 3 seconds", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    const channel = await discord.createChannel({ participants: [ana, discord.app] });

    const command = await ana.runCommand("/deploy web staging", { channel });

    await expect(command!).toBeAccepted({ within: "3s" });
    await expect(channel).toContainText(/deploying web to staging/i);
  });

  test("a deferred answer: the agent thinks, then edits its response", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    const channel = await discord.createChannel({ participants: [ana, discord.app] });

    await ana.runCommand("/report", { channel });

    await expect(channel).toContainText(/weekly report is ready/i);
    await expect(channel).not.toContainText(/is thinking/);
  });

  test("approval buttons act once, even on a double click", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    const ben = await discord.createUser({ name: "Ben", admin: true });
    const channel = await discord.createChannel({ participants: [ana, ben, discord.app] });
    const msg = await ana.say("@my-agent deploy web to staging", { channel });

    const ask = await msg.latestReply({ from: "my-agent" });
    await expect(ask).toHaveButton("Approve");

    await ben.click("Approve", { message: ask });
    await ben.click("Approve", { message: ask }).catch(() => undefined);

    await expect(channel).toContainText("Deploying web to staging", { count: 1 });
  });

  test("people who may not approve get an ephemeral refusal", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    const channel = await discord.createChannel({ participants: [ana, discord.app] });
    await ana.say("@my-agent deploy web to production", { channel });

    await ana.click("Approve", { channel });

    const [refusal] = await ana.ephemeral();
    await expect(refusal!).toBeEphemeralFor(ana);
    await expect(channel).not.toContainText(/^Deploying/);
  });
});

describe("reactions and edits", () => {
  test("acknowledges with a reaction, then answers", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    const channel = await discord.createChannel({ participants: [ana, discord.app] });

    const msg = await ana.say("@my-agent look at the failed build", { channel });

    await expect(msg).toHaveReaction("👀", { by: discord.app });
    await expect(msg).toHaveReplyFrom("my-agent");
  });

  test("an emoji reaction as a trigger", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    const ben = await discord.createUser({ name: "Ben" });
    const channel = await discord.createChannel({ participants: [ana, ben, discord.app] });
    const report = await ben.say("login is broken on Safari", { channel });

    await ana.react("🎫", { message: report });

    await expect(report).toHaveReplyFrom("my-agent", { text: /ENG-\d+/ });
  });

  test("editing the question doesn't produce a second answer", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    const channel = await discord.createChannel({ participants: [ana, discord.app] });
    const msg = await ana.say("@my-agent what's our uptime?", { channel });
    await msg.waitForReply({ from: "my-agent" });

    await ana.edit("@my-agent what's our uptime this month?", { message: msg });

    await expect(msg).toHaveRepliesFrom("my-agent", { count: 1 });
  });
});

describe("delivery and failures (fake only)", () => {
  test("a dropped Gateway connection is resumed, and what it missed is answered once", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    await discord.fault({ type: "drop_gateway" });

    const msg = await ana.say("still there?", { to: discord.app });

    await expect(msg.channel).toHaveRepliesFrom("my-agent", { count: 1, timeout: "20s" });
  });

  test("an interaction with a bad signature is refused", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    const channel = await discord.createChannel({ participants: [ana, discord.app] });
    const command = await ana.runCommand("/deploy web", { channel });
    await command!.settled();

    await command!.resend({ badSignature: true });

    await expect(command!).toBeRejected();
  });

  test("the interactions endpoint passes Discord's check", async ({ discord }) => {
    const check = await discord.verifyEndpoint();

    expect(check.problems).toEqual([]);
    expect(check.valid).toBe(true);
  });

  test("backs off on rate limits and still answers", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    const route = "POST /channels/{channel.id}/messages";
    await using _fault = await discord.fault({ type: "rate_limit", route, retryAfter: "1s", times: 1 });

    const msg = await ana.say("hi", { to: discord.app });

    await expect(msg.channel).toHaveRepliesFrom("my-agent", { count: 1 });
    await expect(discord).toHaveReceivedCall(route, { times: 2 });
  });
});

describe("inspecting what the agent did", () => {
  test("API calls and errors", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    const channel = await discord.createChannel({ participants: [ana, discord.app] });
    await ana.say("@my-agent hi", { channel });

    const post = await discord.waitForCall({ operation: "POST /channels/{channel.id}/messages" });
    expect(post.responseStatus).toBe(200);
    // Discord's JSON error codes: 50001 Missing Access, 50013 Missing Permissions.
    await expect(discord).not.toHaveReceivedCall(/.*/, { error: "50001" });
    expect(await discord.calls({ error: true })).toEqual([]);
  });

  test("a transcript snapshot reads like the conversation", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    const msg = await ana.say("what's 2 + 2?", { to: discord.app });
    await msg.channel.waitForMessage({ from: "my-agent" });

    const transcript = await msg.channel.transcript();
    expect(transcript.toString()).toMatchSnapshot();
  });
});

describe("live mode", () => {
  // With CHANNELSTACK_DISCORD_BOT_TOKEN set, the bot is the agent's real bot in the sandbox guild.
  // Discord has no API that acts as a person, so Ana is a second application's bot in the guild
  // (CHANNELSTACK_DISCORD_USER_ANA_TOKEN), and what she writes carries `author.bot`. The agent
  // hears her from Discord itself; channelstack only acts and reads the result back.
  test.skipIf(!process.env.CHANNELSTACK_DISCORD_USER_ANA_TOKEN)(
    "a real person asks the real bot",
    async ({ discord }) => {
      const ana = await discord.createUser({ name: "Ana" });
      const channel = await discord.createChannel({ participants: [ana, discord.app] });

      const msg = await ana.say("@my-agent summarize #support today", { channel });

      await expect(msg).toHaveReplyFrom("my-agent", { timeout: "30s" });
    },
  );

  // A slash command or a button press is fake-only: Discord lets no bot run another app's command.
  test.skipIf(!process.env.CHANNELSTACK_DISCORD_USER_ANA_TOKEN)("a real reaction", async ({ discord }) => {
    const ana = await discord.createUser({ name: "Ana" });
    const channel = await discord.createChannel({ participants: [ana, discord.app] });
    const msg = await ana.say("The export is broken again", { channel });

    await ana.react("🎫", { message: msg });

    await expect(msg).toHaveReplyFrom("my-agent", { text: /Filed ENG-\d+/, timeout: "30s" });
  });
});
