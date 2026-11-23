import { SLACK_CHECKS, slackChecks } from "../../../integrations/checks/index.ts";
import { onlyFromEnv } from "./only.ts";

// Exit check 2.3: the standard checks, as a developer adds them to a suite. `scripts/examples.ts`
// runs this file against each reference agent, and `test/acceptance/checks-broken.test.ts` runs
// it against an agent with one fault per check.
slackChecks({
  app: "my-agent",
  streamPrompt: "write a long report on Q3",
  approval: { prompt: "@my-agent deploy web to staging", button: "Approve" },
  ...onlyFromEnv(SLACK_CHECKS),
});
