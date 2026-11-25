import { expect, test } from "vitest";

test("the App hears about a repository once it's installed", async ({ github }) => {
  const ana = await github.createUser({ login: "ana" });
  // @show:start
  const repo = await github.createRepo({ collaborators: [ana] }); // not installed
  const issue = await ana.openIssue({ title: "Hello?" }, { repo });
  const comment = await ana.comment("@my-agent ping", { issue });
  expect(comment.delivery).toBeUndefined();

  await repo.installApp(github.app); // sends installation_repositories
  // @show:end
});
