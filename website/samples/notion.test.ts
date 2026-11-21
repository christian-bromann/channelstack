import { test, expect } from "vitest";

// @show:start
test("answers a comment mention in the same discussion", async ({ notion }) => {
  const ana = await notion.createUser({ name: "Ana" });
  const page = await notion.createPage({
    title: "Roadmap",
    content: "# Q1\n- ship search",
    connections: [notion.app],
  });

  const comment = await ana.comment("@robin summarize this page", { page });
  await expect(comment.discussion).toHaveCommentFrom("robin", { text: /search/ });
  await expect(comment.discussion).toHaveCommentsFrom("robin", { count: 1 });
});
// @show:end
