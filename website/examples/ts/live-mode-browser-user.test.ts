import { test } from "vitest";

test("a person signed in with a saved browser session", async ({ slack }) => {
  // @show:start
  const ana = await slack.createUser({ name: "Ana", browser: { storageState: ".auth/ana-slack.json" } });
  // @show:end
  void ana;
});
