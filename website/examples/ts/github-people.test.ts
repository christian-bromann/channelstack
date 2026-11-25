import { test } from "vitest";

test("the people a GitHub test creates", async ({ github }) => {
  // @show:start
  const ana = await github.createUser({ login: "ana" });
  const ben = await github.createUser({ login: "ben", role: "admin", name: "Ben Ortiz" });
  // @show:end
  void [ana, ben];
});
