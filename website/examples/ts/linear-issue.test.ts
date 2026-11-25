import { test } from "vitest";

test("an issue with its fields", async ({ linear }) => {
  const ana = await linear.createUser({ name: "Ana" });
  const ben = await linear.createUser({ name: "Ben", admin: true });
  const team = await linear.createTeam({
    members: [ana, ben],
    labels: ["incident"],
    states: [{ name: "Triage", type: "triage" }],
  });
  // @show:start
  const issue = await ana.createIssue(
    { title: "API latency spike", labels: ["incident"], priority: 2, state: "Triage", assignee: ben },
    { team },
  );
  // @show:end
  void issue;
});
