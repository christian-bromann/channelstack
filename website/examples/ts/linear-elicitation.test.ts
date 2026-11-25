import { test } from "vitest";

test("answering the agent and prompting it again", async ({ linear }) => {
  const ana = await linear.createUser({ name: "Ana" });
  const team = await linear.createTeam({ members: [ana] });
  const issue = await ana.createIssue({ title: "Fix the login bug" }, { team });
  const session = await ana.delegate(linear.app, { issue });
  // @show:start
  const question = await session.waitForActivity({ type: "elicitation" });
  await ana.answer("Only Safari 18", { elicitation: question });

  await ana.prompt("also update the docs", { session });
  // @show:end
});
