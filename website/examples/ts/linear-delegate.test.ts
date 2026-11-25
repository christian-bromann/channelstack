import { expect, test } from "vitest";

test("the ways an issue reaches the agent", async ({ linear }) => {
  const ana = await linear.createUser({ name: "Ana" });
  const team = await linear.createTeam({ members: [ana] });
  const issue = await ana.createIssue({ title: "Checkout fails on Safari" }, { team });
  // @show:start
  const session = await ana.delegate(linear.app, { issue });

  const issue2 = await ana.createIssue({ title: "Bump the Node version", delegate: linear.app }, { team });
  const session2 = await issue2.session();

  const comment = await ana.comment("@my-agent can you take a look?", { issue });
  await expect(comment.session!).toHaveActivity({ type: "response" });

  await ana.undelegate({ issue });
  // @show:end
  void [session, session2];
});
