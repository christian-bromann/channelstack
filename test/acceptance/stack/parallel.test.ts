import { describe, expect, test } from "vitest";

// Exit check 1.7: parallel sessions are isolated. Twenty copies of the DM test run at once in one
// shared workspace; each sees its own conversation and nothing of the others.
describe("20 copies of the DM test in parallel", () => {
  test.concurrent.for(Array.from({ length: 20 }, (_, index) => index + 1))(
    "copy %i gets its own answer and sees nothing of the others",
    async (copy, { slack }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const msg = await ana.say(`what's 2 + 2? (copy ${copy})`, { to: slack.app });

      await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
      const reply = await msg.thread.latestReply({ from: "my-agent" });
      expect(reply.text).toBe("2 + 2 is 4.");

      // Everything this session recorded is about its own DM: the agent's calls and the deliveries to it.
      const calls = await slack.calls();
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const request = call.request as { channel?: string; channel_id?: string } | undefined;
        expect(request?.channel ?? request?.channel_id).toBe(msg.channel);
      }
      const deliveries = await slack.deliveries();
      expect(deliveries.length).toBeGreaterThan(0);
      for (const delivery of deliveries) {
        const event = (delivery.payload as { event: { channel?: string; user?: string; text?: string } }).event;
        expect(event.channel).toBe(msg.channel);
        // What a person wrote is this copy's question; the rest is the agent's own answer coming back.
        if (event.user === ana.id) expect(event.text).toContain(`(copy ${copy})`);
      }
    },
  );
});
