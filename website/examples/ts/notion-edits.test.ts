import { test } from "vitest";

test("editing a page", async ({ notion }) => {
  const ana = await notion.createUser({ name: "Ana" });
  const page = await notion.createPage({ title: "Spec", content: "# Spec\nTODO: billing", connections: [notion.app] });
  // @show:start
  await ana.edit({ append: "## Open questions\n- who owns billing?" }, { page });
  await ana.edit({ replace: "# Draft\nStarting over." }, { page });
  await ana.rename("Spec v2", { page });
  await ana.mention(notion.app, { page, inBlock: "TODO" });
  // @show:end
});
