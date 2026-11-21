import { test, expect } from "vitest";

// @show:start
test("Stop ends a working session", async ({ linear }) => {
  const kai = await linear.createUser({ name: "Kai" });
  const team = await linear.createTeam({ key: "ENG", members: [kai] });
  const issue = await kai.createIssue({ title: "Migrate billing cron" }, { team }); // [!step 1]

  const session = await kai.delegate(linear.app, { issue }); // [!step 2]
  await expect(session).toHaveActivity({ type: "thought" }); // [!step 3]

  await kai.stop({ session }); // [!step 4]
  await expect(session).toHaveSessionState("complete"); // [!step 5]
});
// @show:end
