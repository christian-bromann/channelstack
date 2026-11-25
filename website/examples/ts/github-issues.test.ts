import { test } from "vitest";

test("what people do on an issue", async ({ github }) => {
  const ana = await github.createUser({ login: "ana" });
  const ben = await github.createUser({ login: "ben" });
  const repo = await github.createRepo({
    collaborators: [ana, ben],
    labels: ["bug", "agent:fix"],
    apps: [github.app],
  });
  // @show:start
  const issue = await ana.openIssue({ title: "Typo in the README", labels: ["bug"] }, { repo });

  await ana.comment("@my-agent is this a duplicate?", { issue });
  await ana.label("agent:fix", { issue });
  await ana.assign([ben], { issue });
  await ana.editIssue({ title: "Typo in README.md" }, { issue });
  await ana.close({ issue });
  // @show:end
});
