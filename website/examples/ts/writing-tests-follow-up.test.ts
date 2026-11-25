import { expect, test } from "vitest";

test("a follow-up in the thread", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  // @show:start
  const msg = await ana.say("@my-agent what's the status of the web deploy?", { channel });
  await msg.thread.waitForReply({ from: "my-agent" });

  await ana.reply("and the API?", { thread: msg });

  const answer = await msg.thread.waitForReply({ from: "my-agent" });
  expect(answer.text).toMatch(/api/i);
  // @show:end
});
