import { test, expect } from "vitest";

// @show:start
test("answers a comment mention in the same discussion", async ({ notion }) => {
  const ana = await notion.createUser({ name: "Ana" });
  const page = await notion.createPage({ // [!step 1]
    title: "Roadmap", // [!step 1]
    content: "# Q1\n- ship search", // [!step 1]
    connections: [notion.app], // [!step 1]
  }); // [!step 1]

  const comment = await ana.comment("@robin summarize this page", { page }); // [!step 2]
  await expect(comment.discussion).toHaveCommentFrom("robin", { text: /search/ }); // [!step 3]
  await expect(comment.discussion).toHaveCommentsFrom("robin", { count: 1 }); // [!step 4]
});
// @show:end
