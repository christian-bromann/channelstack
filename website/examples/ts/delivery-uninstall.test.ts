import { expect, test } from "vitest";

// @show:start
test("the uninstall is handled", async ({ slack }) => {
  const deliveries = await slack.uninstallApp();
  for (const delivery of deliveries) await expect(delivery).toBeAccepted();
});
// @show:end
