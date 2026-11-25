import { test } from "vitest";

test("the agent's split view", async ({ slack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const incidents = await slack.createChannel({ name: "incidents", participants: [ana, slack.app] });
  const general = await slack.createChannel({ name: "general", participants: [ana, slack.app] });
  // @show:start
  const thread = await ana.openAgentThread({ from: incidents });
  const prompts = await thread.suggestedPrompts();

  await ana.pickPrompt("What changed?", { thread });
  await ana.switchContext(general, { thread });
  await ana.reply("summarize this channel", { thread });
  // @show:end
  void prompts;
});
