// @show:start
import { expect, test } from "vitest";

test("delegating an issue gets a response in its session", async ({ linear }) => {
  const ana = await linear.createUser({ name: "Ana" });
  const team = await linear.createTeam({ members: [ana] });
  const issue = await ana.createIssue({ title: "Checkout fails on Safari" }, { team });

  const session = await ana.delegate(linear.app, { issue });

  await expect(session).toHaveActivity({ type: "response" });
  await expect(issue).toBeDelegatedTo(linear.app);
});
// @show:end
