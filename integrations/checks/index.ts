/**
 * `channelstack/checks`: the standard behaviour checks. Calling one registers ordinary tests in
 * the suite that is running, on the fixtures and matchers of `channelstack/vitest`:
 *
 *   import { slackChecks } from "channelstack/checks";
 *   slackChecks({ app: "my-agent" });
 *
 * Each check is something agents commonly get wrong, written against the public API only.
 */
import { describe, expect, test, type TestContext } from "vitest";

import type { Duration } from "../../sdks/typescript/client.ts";
// The fixtures and matchers the checks use come from the Vitest integration.
import type {} from "../vitest/index.ts";

export interface ChecksOptions {
  /** The app's name, as people mention it. */
  app: string;
  /** Text that makes the agent reply. Default: `@<app> hello`. */
  prompt?: string;
  /**
   * Text that makes the agent stream a longer answer, in a DM. Without it the stream and Stop
   * checks are left out: not every agent streams.
   */
  streamPrompt?: string;
  /**
   * Text that makes the agent ask for an approval, and the label of the button it shows. A
   * workspace admin may press it; anyone else may not. Without it the click checks are left out.
   */
  approval?: { prompt: string; button: string };
  /** Leave out checks by id, e.g. `["slack.stream-stop"]`. */
  skip?: string[];
  /** How long each check waits for the agent. Default: the integration's timeout. */
  timeout?: Duration;
}

/** The ids of the Slack checks, in the order they are registered. */
export const SLACK_CHECKS = [
  "slack.dm-once",
  "slack.mention-once",
  "slack.in-thread",
  "slack.retry",
  "slack.redelivery",
  "slack.ignores-bots",
  "slack.bad-signature",
  "slack.ack",
  "slack.msg-too-long",
  "slack.stream-stop",
  "slack.stop",
  "slack.click-unauthorized",
  "slack.double-click",
] as const;

type SlackCheck = (typeof SLACK_CHECKS)[number];

/**
 * Registers: replies once to a DM · once to a mention · replies in the thread · survives Slack's
 * 3 s retry · handles redelivery idempotently · ignores other bots' messages · rejects a bad
 * signature · acks within 3 s · handles `msg_too_long` · a stream starts and stops · honours
 * Stop · refuses clicks from people who may not act · a double click acts once.
 */
export function slackChecks(options: ChecksOptions): void {
  const { app } = options;
  const prompt = options.prompt ?? `@${app} hello`;
  const wait = options.timeout === undefined ? {} : { timeout: options.timeout };
  const check = (
    id: SlackCheck,
    title: string,
    run: (context: TestContext) => Promise<void>,
    needs: unknown = true,
  ) => {
    // A check whose prompt wasn't given is left out, like one that was skipped by id.
    if (options.skip?.includes(id) || needs === undefined) return;
    test(`${title} [${id}]`, run);
  };

  describe(`slack checks: ${app}`, () => {
    check("slack.dm-once", "replies once to a DM", async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const msg = await ana.say(prompt, { to: slack.app });
      await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check("slack.mention-once", "replies once to a mention", async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, slack.app] });
      const msg = await ana.say(prompt, { channel });
      await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check("slack.in-thread", "replies in the thread, not in the channel", async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, slack.app] });
      const msg = await ana.say(prompt, { channel });
      await expect(msg.thread).toHaveReplyFrom(app, wait);
      await expect(channel).not.toHaveChannelMessageFrom(app, wait);
    });

    check("slack.retry", "survives Slack's retry after 3 seconds", async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, slack.app] });
      const msg = await ana.say(prompt, { channel });
      // Slack retries what it thinks wasn't acknowledged in time, and says so in the retry headers.
      await msg.delivery?.retry({ after: "3s", reason: "http_timeout" });
      await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check("slack.redelivery", "handles the same event delivered twice", async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, slack.app] });
      const msg = await ana.say(prompt, { channel });
      await expect(msg.thread).toHaveReplyFrom(app, wait);
      // The same event again, with nothing that marks it as a retry: only its event_id tells.
      await msg.delivery?.resend();
      await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check("slack.ignores-bots", "ignores what other bots write", async ({ slack }) => {
      const bot = await slack.createUser({ name: "Deploy Bot", bot: true });
      const channel = await slack.createChannel({ participants: [bot, slack.app] });
      const msg = await bot.say(prompt, { channel });
      await expect(msg.thread).not.toHaveReplyFrom(app, wait);
    });

    check("slack.bad-signature", "rejects a delivery with a bad signature", async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const msg = await ana.say(prompt, { to: slack.app });
      const delivery = msg.delivery;
      if (!delivery) throw new Error("The message caused no delivery to the agent");
      const first = await delivery.settled(wait);
      // Over Socket Mode there is no signature to check: the connection is the app's own.
      if (first.attempts[0]?.transport !== "http") return;
      await delivery.resend({ badSignature: true });
      await expect(delivery).toBeRejected(wait);
    });

    check("slack.ack", "acknowledges within 3 seconds", async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const msg = await ana.say(prompt, { to: slack.app });
      const delivery = msg.delivery;
      if (!delivery) throw new Error("The message caused no delivery to the agent");
      await expect(delivery).toBeAccepted({ within: "3s", ...wait });
    });

    check("slack.msg-too-long", "still answers when Slack refuses its message as too long", async ({ slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, slack.app] });
      // Slack refuses the agent's next message once; an agent that handles it says something shorter.
      await using _fault = await slack.fault({
        type: "error",
        operation: "chat.postMessage",
        error: "msg_too_long",
        times: 1,
      });
      const msg = await ana.say(prompt, { channel });
      await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
    });

    check(
      "slack.stream-stop",
      "a stream it starts, it also stops",
      async ({ slack }) => {
        const ana = await slack.createUser({ name: "Ana" });
        const msg = await ana.say(options.streamPrompt ?? "", { to: slack.app });
        await expect(msg.thread).toHaveStreamingReplyFrom(app, wait);
        const reply = await msg.thread.latestReply({ from: app, ...wait });
        const stream = await reply.stream?.ended(wait);
        expect(stream?.state).toBe("completed");
        await expect(msg.thread).toHaveStatus("idle", wait);
      },
      options.streamPrompt,
    );

    check(
      "slack.stop",
      "honours Stop: nothing more is written after it",
      async ({ slack }) => {
        const ana = await slack.createUser({ name: "Ana" });
        const msg = await ana.say(options.streamPrompt ?? "", { to: slack.app });
        await expect(msg.thread).toHaveStreamingReplyFrom(app, wait);
        await ana.stop({ thread: msg });
        await expect(msg.thread).toHaveStatus("stopped", wait);
        await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
      },
      options.streamPrompt,
    );

    check(
      "slack.click-unauthorized",
      "refuses a click from someone who may not act",
      async ({ slack }) => {
        const approval = options.approval ?? { prompt: "", button: "" };
        const ana = await slack.createUser({ name: "Ana" });
        const channel = await slack.createChannel({ participants: [ana, slack.app] });
        const msg = await ana.say(approval.prompt, { channel });
        await ana.click(approval.button, { thread: msg.thread });
        // The ask is the only thing everyone sees: whatever the agent tells Ana, it tells her alone.
        await expect(msg.thread).toHaveRepliesFrom(app, { count: 1, ...wait });
      },
      options.approval,
    );

    check(
      "slack.double-click",
      "a double click acts once",
      async ({ slack }) => {
        const approval = options.approval ?? { prompt: "", button: "" };
        const ana = await slack.createUser({ name: "Ana" });
        const admin = await slack.createUser({ name: "Ben", admin: true });
        const channel = await slack.createChannel({ participants: [ana, admin, slack.app] });
        const msg = await ana.say(approval.prompt, { channel });
        const ask = await msg.thread.waitForReply({ from: app, ...wait });
        // Both presses are on their way before the agent can answer the first. An agent that takes the
        // button away once it has acted leaves nothing for a later press to find, and that is fine.
        const nothingToPress = (error: unknown) => {
          if ((error as { code?: string }).code !== "not_found") throw error;
        };
        await Promise.all([
          admin.click(approval.button, { message: ask }),
          admin.click(approval.button, { message: ask }).catch(nothingToPress),
        ]);
        // The approval shows up first; then the thread holds the ask and one message for the one approval.
        await msg.thread.waitForReply({ from: app, ...wait });
        await expect(msg.thread).toHaveRepliesFrom(app, { count: 2, ...wait });
      },
      options.approval,
    );
  });
}
