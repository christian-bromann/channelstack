import { test } from "vitest";

test("a team with its labels and workflow states", async ({ linear }) => {
  const ana = await linear.createUser({ name: "Ana" });
  const ben = await linear.createUser({ name: "Ben", admin: true });
  // @show:start
  const team = await linear.createTeam({
    key: "OPS",
    members: [ana, ben],
    labels: ["incident"],
    states: [
      { name: "Triage", type: "triage" },
      { name: "Investigating", type: "started" },
      { name: "Resolved", type: "completed" },
    ],
  });
  // @show:end
  void team;
});
