import { describe, expect, test } from "vitest";

// Exit check 13.5: 20 copies of a scripted tool loop at the same moment, against one agent and one
// fake OpenAI. Each test's prompt is its own, and each gets only its own answers: the model calls
// of one session never reach another's scripts.
describe("parallel sessions on one fake OpenAI", () => {
  test.concurrent.for(Array.from({ length: 20 }, (_, at) => at))(
    "copy %i gets its own answers",
    async (at, { slack, openai }) => {
      const ana = await slack.createUser({ name: "Ana" });
      const channel = await slack.createChannel({ participants: [ana, slack.app] });
      const ai = await openai.respond([
        { toolCalls: [{ name: "search_incidents", arguments: { query: `incident ${at}` } }] },
        `Answer for copy ${at}.`,
      ]);

      const msg = await ana.say(`@my-agent what happened in incident number ${at} last night?`, { channel });

      await expect(msg.thread).toHaveReplyFrom("my-agent", {
        text: new RegExp(`^Answer for copy ${at}\\.$`),
        timeout: "30s",
      });
      await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1, timeout: "30s" });
      await expect(ai).toHaveAnswered({ times: 2, timeout: "30s" });
      expect(await openai.unattributed()).toEqual([]);
    },
  );
});
