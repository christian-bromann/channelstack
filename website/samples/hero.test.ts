import { expect, test } from "vitest";

test("ships a PR from a Slack DM", async ({ slack }) => {
  const ana = await slack.createUser({ name: "ana" });
  const dm = { to: slack.app };
  // [!step 1]
  const msg = await ana.say("@my-agent ship #812 to staging", dm);

  // [!step 2]
  await expect(msg.thread).toHaveStatusText(/checking CI/);
  // [!step 3]
  const ask = await msg.thread.waitForReply({ from: "my-agent" });
  await expect(ask).toHaveButton("Approve");

  // [!step 4]
  await ana.click("Approve", { message: ask });
  // [!step 5]
  await expect(msg.thread).toContainText(/Deployed/, { count: 1 });
  await expect(msg.thread).not.toContainText("Thinking…");
});
