/**
 * Patterns shared by every channel: people as reusable fixtures, and the standard checks.
 * Per-channel examples: slack.test.ts, github.test.ts, linear.test.ts, notion.test.ts, resend.test.ts,
 * google.test.ts, twilio.test.ts.
 */
import { expect } from "vitest";
import { test } from "./fixtures";
import {
  slackChecks, githubChecks, linearChecks, notionChecks, resendChecks, googleChecks, twilioChecks,
} from "channelstack/checks";

// People and places as fixtures: created per test, cleaned up after it.
test("answers in #support", async ({ support, ana }) => {
  const msg = await ana.say("@my-agent what broke last night?", { channel: support });
  await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
});

test("an admin and a regular member see the same answer", async ({ support, ana, ben }) => {
  const question = await ana.say("@my-agent who's on call?", { channel: support });
  await ben.reply("+1, also need this", { thread: question });
  await expect(question.thread).toHaveRepliesFrom("my-agent", { count: 1 });
});

// The standard behaviour checks register ordinary tests. Skip what doesn't apply.
slackChecks({ app: "my-agent" });
githubChecks({ app: "my-agent", skip: ["github.check-run"] });
linearChecks({ app: "my-agent" });
notionChecks({ app: "my-agent", prompt: "@my-agent summarize this page" });
resendChecks({ app: "my-agent", prompt: "Where is my refund?" });
googleChecks({ app: "my-agent", prompt: "Where is my refund?" });
twilioChecks({ app: "my-agent", prompt: "Where is my order?" });
