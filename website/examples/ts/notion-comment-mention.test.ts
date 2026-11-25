// @show:start
import { expect, test } from "vitest";

test("a mention in a page comment gets a reply in the same discussion", async ({ notion }) => {
  const ana = await notion.createUser({ name: "Ana" });
  const page = await notion.createPage({
    title: "Roadmap",
    content: "# Q1\n- ship search\n- ship billing",
    connections: [notion.app],
  });

  const comment = await ana.comment("@my-agent summarize this page", { page });

  await expect(comment.discussion).toHaveCommentFrom("my-agent", { text: /search/i });
  await expect(comment.discussion).toHaveCommentsFrom(notion.app, { count: 1 });
});
// @show:end
