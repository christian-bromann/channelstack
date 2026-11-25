import { test } from "vitest";

test("what each action resolves to", async ({ slack, github, linear }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  const ben = await github.createUser({ login: "ben" });
  const repo = await github.createRepo({ collaborators: [ben], apps: [github.app] });
  const issue = await ben.openIssue({ title: "Flaky test" }, { repo });
  const mo = await linear.createUser({ name: "Mo" });
  const team = await linear.createTeam({ members: [mo] });
  const ticket = await mo.createIssue({ title: "Checkout fails on Safari" }, { team });
  // @show:start
  const msg = await ana.say("@my-agent hi", { channel });
  msg.delivery; // the app_mention event_callback

  const comment = await ben.comment("@my-agent investigate", { issue });
  comment.delivery; // the issue_comment webhook

  const session = await mo.delegate(linear.app, { issue: ticket });
  session.delivery; // the AgentSessionEvent that opened the session

  const command = await ana.runCommand("/deploy web staging", { channel });
  // a slash command, click, shortcut or modal submission resolves to its delivery
  // @show:end
  void command;
});
