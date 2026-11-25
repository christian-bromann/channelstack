import { expect, test } from "vitest";

test("a redelivered webhook is answered once", async ({ github }) => {
  const ana = await github.createUser({ login: "ana" });
  const repo = await github.createRepo({ collaborators: [ana], apps: [github.app] });
  const issue = await ana.openIssue({ title: "Flaky test" }, { repo });
  // @show:start
  const comment = await ana.comment("@my-agent investigate", { issue });
  await expect(issue).toHaveCommentFrom(github.app);

  await comment.delivery!.redeliver();
  await expect(issue).toHaveCommentsFrom(github.app, { count: 1, quietFor: "2s" });
  // @show:end
});
