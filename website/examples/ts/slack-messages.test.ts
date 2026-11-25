import { test } from "vitest";

test("what people write in Slack", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  // @show:start
  const msg = await ana.say("@my-agent what's the status of the web deploy?", { channel });
  await msg.thread.waitForReply({ from: "my-agent" });

  await ana.reply("and the API?", { thread: msg });
  await ana.edit("@my-agent what's the status of the web deploy today?", { message: msg });
  await ana.react("ticket", { message: msg });
  await ana.delete({ message: msg });
  // @show:end
});
