import { expect, test } from "vitest";

test("a page the integration isn't connected to", async ({ notion }) => {
  const ana = await notion.createUser({ name: "Ana" });
  // @show:start
  const notes = await notion.createPage({ title: "Private notes" }); // not connected
  const comment = await ana.comment("@my-agent read this", { page: notes });
  expect(comment.delivery).toBeUndefined();

  await ana.connect(notion.app, { page: notes });
  // @show:end
});
