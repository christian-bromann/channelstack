import { expect, test } from "vitest";

test("the transcript a person reads", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  // @show:start
  const msg = await ana.say("what's 2 + 2?", { to: slack.app });
  await msg.thread.latestReply({ from: "my-agent" });

  const transcript = await msg.thread.transcript();
  expect(transcript.toString()).toMatchSnapshot();
  // @show:end
});
