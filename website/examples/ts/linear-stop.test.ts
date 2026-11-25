import { expect, test } from "vitest";

test("Stop ends the session", async ({ linear }) => {
  const ana = await linear.createUser({ name: "Ana" });
  const team = await linear.createTeam({ members: [ana] });
  const issue = await ana.createIssue({ title: "Checkout fails on Safari" }, { team });
  const session = await ana.delegate(linear.app, { issue });
  // @show:start
  await expect(session).toHaveActivity({ type: "thought" });
  await ana.stop({ session });
  await expect(session).toHaveSessionState("complete");
  // @show:end
});
