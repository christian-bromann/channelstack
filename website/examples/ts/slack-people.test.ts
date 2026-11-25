import { test } from "vitest";

test("the people a Slack test creates", async ({ slack }) => {
  // @show:start
  const ana = await slack.createUser({ name: "Ana" });
  const ben = await slack.createUser({ name: "Ben", admin: true });
  const deployBot = await slack.createUser({ name: "deploy-bot", bot: true });
  const cara = await slack.createUser({ name: "Cara", id: "U0ADMIN01" });
  // @show:end
  void [ana, ben, deployBot, cara];
});
