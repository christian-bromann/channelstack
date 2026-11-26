import { expect, test } from "vitest";

// @show:start
test("Stop ends a working session", async ({ linear }) => {
  const kai = await linear.createUser({ name: "Kai" });
  const team = await linear.createTeam({ key: "ENG", members: [kai] });
  // [!step 1]
  const issue = await kai.createIssue({ title: "Migrate cron" }, { team });

  // [!step 2]
  const session = await kai.delegate(linear.app, { issue });
  // [!step 3]
  await expect(session).toHaveActivity({ type: "thought" });

  // [!step 4]
  await kai.stop({ session });
  // [!step 5]
  await expect(session).toHaveSessionState("complete");
});
// @show:end
