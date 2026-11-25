import { expect, test } from "vitest";

// @show:start
test("a redelivered webhook doesn't duplicate activities", async ({ linear }) => {
  const ana = await linear.createUser({ name: "Ana" });
  const team = await linear.createTeam({ members: [ana] });
  const issue = await ana.createIssue({ title: "Anything" }, { team });
  const session = await ana.delegate(linear.app, { issue });
  await expect(session).toHaveActivity({ type: "thought" });
  const before = (await session.activities()).length;

  await session.delivery!.redeliver();

  await expect(issue).toHaveSessionState("complete");
  const thoughts = (await session.activities()).filter((a) => a.type === "thought");
  expect(thoughts.length).toBeLessThanOrEqual(before);
});
// @show:end
