import { expect, test } from "vitest";

test("live: the App's delivery log", async ({ github }) => {
  const ana = await github.createUser({ login: "ana" });
  const repo = await github.createRepo({ collaborators: [ana], apps: [github.app] });
  const issue = await ana.openIssue({ title: "Hello?" }, { repo });
  await ana.comment("@my-agent ping", { issue });
  // @show:start
  await expect
    .poll(async () => (await github.deliveries({ type: "issue_comment", resource: repo })).length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  // @show:end
});
