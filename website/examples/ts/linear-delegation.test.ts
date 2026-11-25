// @show:start
import { expect, test } from "vitest";

test("delegating an issue opens one session with a first thought", async ({ linear }) => {
  const ana = await linear.createUser({ name: "Ana" });
  const team = await linear.createTeam({ members: [ana] });
  const issue = await ana.createIssue({ title: "Checkout fails on Safari" }, { team });

  const session = await ana.delegate(linear.app, { issue });

  await expect(session).toHaveActivity({ type: "thought" }, { timeout: "10s" });
  await expect(issue).toBeDelegatedTo(linear.app);
  expect(await issue.sessions()).toHaveLength(1);
});
// @show:end
