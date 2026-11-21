import { SLACK_CHECKS, slackChecks } from "../../../integrations/checks/index.ts";

// Exit check 2.3: the standard checks, as a developer adds them to a suite. `scripts/examples.ts`
// runs this file against each reference agent, and `test/acceptance/checks-broken.test.ts` runs
// it against an agent with one fault per check.
slackChecks({
  app: "my-agent",
  streamPrompt: "write a long report on Q3",
  approval: { prompt: "@my-agent deploy web to staging", button: "Approve" },
  ...(process.env.CHANNELSTACK_CHECKS_ONLY ? { skip: skipAllBut(process.env.CHANNELSTACK_CHECKS_ONLY) } : {}),
});

/** Every check id but one: how the broken-agent test runs a single check. */
function skipAllBut(only: string): string[] {
  return SLACK_CHECKS.filter((id) => id !== only);
}
