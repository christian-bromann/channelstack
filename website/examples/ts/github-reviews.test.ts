import { test } from "vitest";

test("reviews, review comments and merging", async ({ github }) => {
  const ana = await github.createUser({ login: "ana" });
  const ben = await github.createUser({ login: "ben" });
  const repo = await github.createRepo({ files: "./fixtures/web", collaborators: [ana, ben], apps: [github.app] });
  const pr = await ana.openPullRequest(
    { from: "feat", draft: true, changes: { "src/app.ts": "export const x = 1\n" } },
    { repo },
  );
  // @show:start
  await ana.markReady({ pr });
  await ben.review({
    pr,
    event: "REQUEST_CHANGES",
    body: "@my-agent please address these",
    comments: [{ path: "src/app.ts", line: 1, body: "name this something clearer" }],
  });

  const inline = await ana.reviewComment("@my-agent why is this exported?", { pr, path: "src/app.ts", line: 1 });
  await ana.reply("thanks", { comment: inline });
  await ana.resolve({ comment: inline });

  await ana.requestReview([ben], { pr });
  await ana.merge({ pr, method: "squash" });
  // @show:end
});
