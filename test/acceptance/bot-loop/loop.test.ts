import { test } from "vitest";

// Run by `../plugin-defaults.test.ts`, and meant to fail: two apps answer each other in a thread
// with no person between them, past the loop guard's 50 messages (decision 0027). The test checks
// nothing itself; its fixture fails it at teardown, naming the loop the fake stopped.
test("two apps that answer each other without end", async ({ slack }) => {
  const ping = await slack.createApp({ name: "loop-ping" });
  const pong = await slack.createApp({ name: "loop-pong" });
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, ping, pong] });
  const msg = await ana.say("@loop-ping @loop-pong talk it over", { channel });
  for (let turn = 0; turn < 26; turn++) {
    await ping.reply("@loop-pong over to you", { thread: msg.thread });
    await pong.reply("@loop-ping over to you", { thread: msg.thread });
  }
});
