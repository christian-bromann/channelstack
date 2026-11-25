import { test } from "vitest";

test("people act, resources are read", async ({ slack, github, linear, notion }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const ben = await slack.createUser({ name: "Ben", admin: true });
  const channel = await slack.createChannel({ participants: [ana, ben, slack.app] });
  const asked = await ana.say("@my-agent deploy web to staging", { channel });
  const reply = await asked.thread.latestReply({ from: "my-agent" });
  const cara = await github.createUser({ login: "cara" });
  const repo = await github.createRepo({ collaborators: [cara], apps: [github.app] });
  const pr = await cara.openPullRequest({ from: "fix-login", changes: { "src/login.ts": "export {};\n" } }, { repo });
  const dev = await linear.createUser({ name: "Dev" });
  const team = await linear.createTeam({ members: [dev] });
  const issue = await dev.createIssue({ title: "Checkout fails on Safari" }, { team });
  const eve = await notion.createUser({ name: "Eve" });
  const page = await notion.createPage({ title: "Roadmap", connections: [notion.app] });
  const { discussion } = await eve.comment("@my-agent summarize this page", { page });
  // @show:start
  await ana.say("@my-agent deploy web", { channel });
  await ben.click("Approve", { message: reply });
  await cara.comment("@my-agent fix this", { issue: pr });
  await dev.delegate(linear.app, { issue });
  await eve.reply("thanks!", { discussion });
  // @show:end
});
