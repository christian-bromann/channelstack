import { expect, test } from "vitest";

// @show:start
test("answers a comment mention in the same discussion", async ({ notion }) => {
  const ana = await notion.createUser({ name: "Ana" });
  // [!step 1]
  const page = await notion.createPage({
    title: "Roadmap",
    content: "# Q1\n- ship search",
    connections: [notion.app],
  });

  // [!step 2]
  const comment = await ana.comment("@robin summarize this page", { page });
  // [!step 3]
  await expect(comment.discussion).toHaveCommentFrom("robin", { text: /search/ });
  // [!step 4]
  await expect(comment.discussion).toHaveCommentsFrom("robin", { count: 1 });
});
// @show:end
