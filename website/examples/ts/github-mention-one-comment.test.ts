// @show:start
import { expect, test } from "vitest";

test("a mention in an issue gets one comment, and no self-trigger loop", async ({ github }) => {
  const ana = await github.createUser({ login: "ana" });
  const repo = await github.createRepo({ collaborators: [ana], apps: [github.app] });
  const issue = await ana.openIssue({ title: "Login fails on Safari", body: "Steps: …" }, { repo });

  await ana.comment("@my-agent can you triage this?", { issue });

  await expect(issue).toHaveCommentFrom(github.app, { text: /triage/i });
  await expect(issue).toHaveCommentsFrom(github.app, { count: 1, quietFor: "2s" });
});
// @show:end
