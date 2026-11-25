import { test } from "vitest";

test("waitFor… and latest…", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const ben = await slack.createUser({ name: "Ben", admin: true });
  const channel = await slack.createChannel({ participants: [ana, ben, slack.app] });
  const msg = await ana.say("@my-agent deploy web to staging", { channel });
  // @show:start
  // The next new reply from the agent: returns as soon as one arrives.
  const answer = await msg.thread.waitForReply({ from: "my-agent" });

  // The agent's last reply, once it's done: waits for at least one, then for quiet.
  const ask = await msg.thread.latestReply({ from: "my-agent" });
  await ben.click("Approve", { message: ask });
  // @show:end
  void answer;
});
