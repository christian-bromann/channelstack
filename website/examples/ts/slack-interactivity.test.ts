import { test } from "vitest";

test("buttons, menus, modals, commands and shortcuts", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const ben = await slack.createUser({ name: "Ben", admin: true });
  const channel = await slack.createChannel({ participants: [ana, ben, slack.app] });
  const msg = await ana.say("@my-agent deploy web", { channel });
  const report = await ana.say("Checkout is down for some people", { channel });
  // @show:start
  const ask = await msg.thread.latestReply({ from: "my-agent" });
  await ben.click("Approve", { message: ask });

  await ana.select("staging", { menu: "Environment", message: ask });

  await ana.click("Open form", { thread: msg.thread });
  const modal = await ana.waitForModal({ title: /incident/i });
  await modal.submit({ Severity: "SEV2", Summary: "Checkout errors" });

  await ana.runCommand("/deploy web staging", { channel });
  await ana.shortcut("create_ticket", { message: report });
  // @show:end
});
