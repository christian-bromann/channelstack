// @show:start
import { expect, test } from "vitest";

test("streams the answer into the DM, and the status clears", async ({ slack, openai }) => {
  await openai.respond(
    { text: ["The web deploy", " failed at", " the migration", " step."] },
    { timing: { firstToken: "700ms", betweenChunks: "250ms" } },
  );
  const ana = await slack.createUser({ name: "Ana" });
  const msg = await ana.say("why did the deploy fail?", { to: slack.app });

  await expect(msg.thread).toHaveStatus("working");
  await expect(msg.thread).toHaveStatusText(/thinking/i);
  await expect(msg.thread).toHaveStreamingReplyFrom("my-agent");
  await expect(msg.thread).toHaveStatus("idle");
  await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /failed at the migration step/ });
  await expect(openai).toHaveSent(msg);
});

test("the agent runs the tool the model calls, and answers from its result", async ({ slack, openai }) => {
  const ai = await openai.respond([
    { toolCalls: [{ name: "search_incidents", arguments: { since: "yesterday" } }] },
    "Two incidents yesterday: the web deploy and a DNS blip.",
  ]);
  const ana = await slack.createUser({ name: "Ana" });
  const msg = await ana.say("what broke yesterday?", { to: slack.app });

  await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /DNS blip/ });
  await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
  await expect(ai).toHaveAnswered({ times: 2 });
  await expect(ai).toHaveSentToolResult("search_incidents", { text: /migration/ });
});
// @show:end
