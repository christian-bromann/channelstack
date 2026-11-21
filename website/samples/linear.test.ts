import { test, expect } from "vitest";

// @show:start
test("Stop ends a working session", async ({ linear }) => {
  const kai = await linear.createUser({ name: "Kai" });
  const team = await linear.createTeam({ key: "ENG", members: [kai] });
  const issue = await kai.createIssue({ title: "Migrate billing cron" }, { team });

  const session = await kai.delegate(linear.app, { issue });
  await expect(session).toHaveActivity({ type: "thought" });

  await kai.stop({ session });
  await expect(session).toHaveSessionState("complete");
});
// @show:end
