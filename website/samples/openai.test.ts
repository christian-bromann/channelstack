import { expect, test } from "vitest";

// @show:start
test("answers from a tool call, once", async ({ slack, openai }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ name: "ops", participants: [ana, slack.app] });
  const ai = await openai.respond([
    { toolCalls: [{ name: "search_incidents", arguments: { since: "yesterday" } }] },
    "Two incidents yesterday: the web deploy and a DNS blip.",
  ]);
  // [!step 1]
  const msg = await ana.say("@my-agent what broke yesterday?", { channel });

  // [!step 2]
  await expect(ai).toHaveOfferedTool("search_incidents");
  // [!step 3]
  await expect(ai).toHaveSentToolResult("search_incidents", { text: /migration/ });
  // [!step 4]
  await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /DNS blip/ });
  // [!step 5]
  await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
  await expect(ai).toHaveAnswered({ times: 2 });
  await expect(openai).not.toHaveSentSecrets();
});
// @show:end
