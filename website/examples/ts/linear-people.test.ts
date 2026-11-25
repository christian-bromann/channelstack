import { test } from "vitest";

test("the people a Linear test creates", async ({ linear }) => {
  // @show:start
  const ana = await linear.createUser({ name: "Ana" });
  const ben = await linear.createUser({ name: "Ben", admin: true });
  // @show:end
  void [ana, ben];
});
