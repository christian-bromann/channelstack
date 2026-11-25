import { expect, test } from "vitest";

test("a transcript snapshot", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const msg = await ana.say("what's 2 + 2?", { to: slack.app });
  await msg.thread.latestReply({ from: "my-agent" });
  // @show:start
  const transcript = await msg.thread.transcript();
  expect(transcript.toString()).toMatchSnapshot();
  // @show:end
});
