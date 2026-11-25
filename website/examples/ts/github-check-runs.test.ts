import { expect, test } from "vitest";

test("the App's check run and its buttons", async ({ github }) => {
  const ana = await github.createUser({ login: "ana" });
  const repo = await github.createRepo({ files: "./fixtures/web", collaborators: [ana], apps: [github.app] });
  const pr = await ana.openPullRequest(
    { from: "fix-login", changes: { "src/app.ts": "export const broken = ;\n" } },
    { repo },
  );
  // @show:start
  await expect(pr).toHaveCheckRun("my-agent", { conclusion: "action_required" });
  const [run] = await pr.checkRuns();

  await ana.requestAction("autofix", { checkRun: run! });
  await ana.rerun({ checkRun: run! });
  // @show:end
});
