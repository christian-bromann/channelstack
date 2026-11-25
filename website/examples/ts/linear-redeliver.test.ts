import { expect, test } from "vitest";

test("Linear's delivery specifics", async ({ linear }) => {
  const ana = await linear.createUser({ name: "Ana" });
  const team = await linear.createTeam({ members: [ana] });
  const issue = await ana.createIssue({ title: "Anything" }, { team });
  // @show:start
  const session = await ana.delegate(linear.app, { issue });

  await session.delivery!.redeliver(); // same webhook, new timestamp, signed again
  await session.delivery!.resend({ stale: true });
  await expect(session.delivery!).toBeRejected();
  // @show:end
});
