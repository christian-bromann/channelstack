import { test } from "vitest";

test("what people do to an issue", async ({ linear }) => {
  const ana = await linear.createUser({ name: "Ana" });
  const ben = await linear.createUser({ name: "Ben" });
  const team = await linear.createTeam({ members: [ana, ben], labels: ["incident"] });
  const issue = await ana.createIssue({ title: "API latency spike" }, { team });
  // @show:start
  await ana.setState("In Progress", { issue });
  await ana.assign(ben, { issue });
  await ana.label(["incident"], { issue });
  await ana.editIssue({ priority: 1 }, { issue });

  const comment = await ana.comment("Is this still happening?", { issue });
  await ana.reply("@my-agent can you check the logs?", { comment });
  await ana.edit("Is this still happening on Safari?", { comment });
  // @show:end
});
