import { test } from "vitest";

test("pull requests and pushes", async ({ github }) => {
  const ana = await github.createUser({ login: "ana" });
  const repo = await github.createRepo({ files: "./fixtures/web", collaborators: [ana], apps: [github.app] });
  // @show:start
  const pr = await ana.openPullRequest(
    { from: "fix-login", title: "Fix login redirect", changes: { "src/login.ts": "export const redirect = '/home';\n" } },
    { repo },
  );

  const commit = await ana.push({ "src/app.ts": "export const broken = ;\n" }, { repo, branch: "fix-login", message: "wip" });
  // @show:end
  void [pr, commit];
});
