import { test, expect } from "vitest";
test("misuse", async ({ slack, github }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  // @ts-expect-error where is required
  await ana.say("hi");
  // @ts-expect-error a GitHub app can't join a Slack channel
  await slack.createChannel({ participants: [github.app] });
  // @ts-expect-error channels no longer have actions
  await channel.say(ana, "hi");
  // @ts-expect-error a Slack user can't comment on GitHub
  await ana.comment("x", { issue: {} as any });
  // @ts-expect-error count is required
  await expect(channel).toHaveCommentsFrom("my-agent", {});
  // @ts-expect-error count is required for an exact reply count
  await expect(channel).toHaveRepliesFrom("my-agent");
  // @ts-expect-error the old positional form is gone
  await (await ana.say("hi", { channel })).thread.waitForReply("my-agent");
});
