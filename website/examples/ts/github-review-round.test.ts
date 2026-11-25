// @show:start
import { expect, test } from "vitest";

test("a full review round: changes requested, fixed, approved, merged", async ({ github }) => {
  const ana = await github.createUser({ login: "ana" });
  const ben = await github.createUser({ login: "ben" });
  const repo = await github.createRepo({ files: "./fixtures/web", collaborators: [ana, ben], apps: [github.app] });
  const pr = await ana.openPullRequest(
    { from: "feat", draft: true, changes: { "src/app.ts": "export const x = 1\n" } },
    { repo },
  );

  await ana.markReady({ pr });
  await ben.review({
    pr,
    event: "REQUEST_CHANGES",
    body: "@my-agent please address these",
    comments: [{ path: "src/app.ts", line: 1, body: "name this something clearer" }],
  });

  const fix = await pr.headCommit();
  expect(fix.author?.name).toBe(github.app.name);
  await ben.review({ pr, event: "APPROVE" });
  await ana.merge({ pr, method: "squash" });
  await expect(pr).toBeMerged();
});
// @show:end
