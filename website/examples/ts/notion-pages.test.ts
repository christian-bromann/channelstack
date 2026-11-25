import { test } from "vitest";

test("the pages a Notion test creates", async ({ notion }) => {
  // @show:start
  const space = await notion.createPage({ title: "Engineering", connections: [notion.app] });
  const spec = await notion.createPage({
    title: "Spec",
    parent: space,
    content: { path: "./fixtures/spec.md" },
    icon: "📐",
  });
  // @show:end
  void spec;
});
