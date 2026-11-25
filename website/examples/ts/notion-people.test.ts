import { test } from "vitest";

test("the people a Notion test creates", async ({ notion }) => {
  // @show:start
  const ana = await notion.createUser({ name: "Ana" });
  const ben = await notion.createUser({ name: "Ben", email: "ben@example.com" });
  // @show:end
  void [ana, ben];
});
