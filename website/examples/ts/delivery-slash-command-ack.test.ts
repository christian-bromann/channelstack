import { expect, test } from "vitest";

// @show:start
test("a slash command is acknowledged within 3 seconds", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });

  const command = await ana.runCommand("/deploy web staging", { channel });

  await expect(command).toBeAccepted({ within: "3s" });
  await expect(channel).toContainText(/deploying web to staging/i);
});
// @show:end
