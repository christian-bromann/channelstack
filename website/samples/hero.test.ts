import { test, expect } from "vitest";

test("ships a PR from a Slack DM", async ({ slack }) => {
  const ana = await slack.createUser({ name: "ana" });
  const msg = await ana.say("@robin ship #812 to staging", // [!step 1]
    { to: slack.app }); // [!step 1]

  await expect(msg.thread).toHaveStatusText(/checking CI/); // [!step 2]
  const ask = await msg.thread.waitForReply({ from: "robin" }); // [!step 3]
  await expect(ask).toHaveButton("Approve"); // [!step 3]

  await ana.click("Approve", { message: ask }); // [!step 4]
  await expect(msg.thread).toContainText(/Deployed/, { count: 1 }); // [!step 5]
  await expect(msg.thread).not.toContainText("Thinking…"); // [!step 5]
});
