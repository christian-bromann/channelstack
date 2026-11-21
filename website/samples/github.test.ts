import { test, expect } from "vitest";

// @show:start
test("answers on the issue and ignores itself", async ({ github }) => {
  const mo = await github.createUser({ login: "mo" });
  const repo = await github.createRepo({ collaborators: [mo], apps: [github.app] });
  const issue = await mo.openIssue({ title: "Login 500s on Safari" }, { repo });

  const comment = await mo.comment("@robin can you take a look?", { issue });
  await expect(issue).toHaveCommentFrom("robin", { text: /Safari/ });

  // the same delivery again must not start a second run
  await comment.delivery!.redeliver();
  await expect(issue).toHaveCommentsFrom("robin", { count: 1 });
});
// @show:end
