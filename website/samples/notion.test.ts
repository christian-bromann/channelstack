import { expect, test } from "vitest";

// @show:start
test("answers a mention in the same discussion", async ({ notion }) => {
  const ana = await notion.createUser({ name: "Ana" });
  // [!step 1]
  const page = await notion.createPage({
    title: "Roadmap",
    content: "# Q1\n- ship search",
    connections: [notion.app],
  });

  // [!step 2]
  const comment = await ana.comment("@my-agent summarize", { page });
  // [!step 3]
  const thread = comment.discussion;
  await expect(thread).toHaveCommentFrom("my-agent", { text: /search/ });
  // [!step 4]
  await expect(thread).toHaveCommentsFrom("my-agent", { count: 1 });
});
// @show:end
