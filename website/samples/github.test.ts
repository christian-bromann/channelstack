import { test, expect } from "vitest";

// @show:start
test("answers on the issue and ignores itself", async ({ github }) => {
  const mo = await github.createUser({ login: "mo" });
  const repo = await github.createRepo({ collaborators: [mo], apps: [github.app] });
  const issue = await mo.openIssue({ title: "Login 500s on Safari" }, { repo }); // [!step 1]

  const comment = await mo.comment("@robin can you take a look?", { issue }); // [!step 2]
  await expect(issue).toHaveCommentFrom("robin", { text: /Safari/ }); // [!step 3]

  // the same delivery again must not start a second run
  await comment.delivery!.redeliver(); // [!step 4]
  await expect(issue).toHaveCommentsFrom("robin", { count: 1 }); // [!step 5]
});
// @show:end
