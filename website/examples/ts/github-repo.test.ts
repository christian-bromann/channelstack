import { test } from "vitest";

test("a repository with files, collaborators, labels and the App", async ({ github }) => {
  const ana = await github.createUser({ login: "ana" });
  const ben = await github.createUser({ login: "ben", role: "admin", name: "Ben Ortiz" });
  // @show:start
  const repo = await github.createRepo({
    name: "web",
    files: "./fixtures/web",
    collaborators: [ana, { user: ben, permission: "maintain" }],
    labels: ["bug", { name: "agent:fix", color: "5319e7" }],
    apps: [github.app],
  });
  // @show:end
  void repo;
});
