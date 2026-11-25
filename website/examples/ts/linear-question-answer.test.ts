// @show:start
import { expect, test } from "vitest";

test("the agent asks a question and continues after the answer", async ({ linear }) => {
  const ana = await linear.createUser({ name: "Ana" });
  const team = await linear.createTeam({ members: [ana] });
  const issue = await ana.createIssue({ title: "Fix the login bug" }, { team });
  const session = await ana.delegate(linear.app, { issue });

  const question = await session.waitForActivity({ type: "elicitation" });
  await expect(issue).toHaveSessionState("awaitingInput");
  await ana.answer("Only Safari 18", { elicitation: question });

  await expect(session).toHaveActivity({ type: "response", text: /safari 18/i });
  await expect(linear).toHaveReceivedCall("agentActivityCreate");
  expect(await linear.calls({ error: true })).toEqual([]);
});
// @show:end
