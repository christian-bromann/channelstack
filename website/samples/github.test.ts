import { expect, test } from "vitest";

// @show:start
test("answers on the issue and ignores itself", async ({ github }) => {
  const mo = await github.createUser({ login: "mo" });
  const repo = await github.createRepo({ collaborators: [mo], apps: [github.app] });
  // [!step 1]
  const issue = await mo.openIssue({ title: "Login 500s on Safari" }, { repo });

  // [!step 2]
  const comment = await mo.comment("@my-agent can you take a look?", { issue });
  // [!step 3]
  await expect(issue).toHaveCommentFrom("my-agent", { text: /Safari/ });

  // the same delivery again must not start a second run
  // [!step 4]
  await comment.delivery!.redeliver();
  // [!step 5]
  await expect(issue).toHaveCommentsFrom("my-agent", { count: 1 });
});
// @show:end
