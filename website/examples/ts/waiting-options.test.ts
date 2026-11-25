import { expect, test } from "vitest";

test("a check's own timeout and quietFor", async ({ slack, github }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const msg = await ana.say("@my-agent hi", { to: slack.app });
  const ben = await github.createUser({ login: "ben" });
  const repo = await github.createRepo({ collaborators: [ben], apps: [github.app] });
  const issue = await ben.openIssue({ title: "Flaky test" }, { repo });
  await ben.comment("@my-agent investigate", { issue });
  // @show:start
  await expect(issue).toHaveCommentsFrom(github.app, { count: 1, quietFor: "2s" });
  await expect(msg.thread).toHaveReplyFrom("my-agent", { timeout: "30s" });
  // @show:end
});
