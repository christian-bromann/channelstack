import { test } from "vitest";

test("files and fixture directories", async ({ github, notion }) => {
  const ana = await github.createUser({ login: "ana" });
  // @show:start
  const repo = await github.createRepo({
    files: "./fixtures/web",
    collaborators: [ana],
    apps: [github.app],
  });

  const pr = await ana.openPullRequest(
    {
      from: "fix-login",
      title: "Fix login redirect",
      changes: { "src/login.ts": "export const redirect = '/home';\n" },
    },
    { repo },
  );

  const spec = await notion.createPage({
    title: "Spec",
    content: { path: "./fixtures/spec.md" },
    connections: [notion.app],
  });
  // @show:end
  void [pr, spec];
});
