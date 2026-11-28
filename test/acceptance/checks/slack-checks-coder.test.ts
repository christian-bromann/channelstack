import { SLACK_CHECKS, slackChecks } from "../../../integrations/checks/index.ts";
import { onlyFromEnv } from "./only.ts";

// Exit check 12.7: the same checks against another app (decision 0027). `scripts/examples.ts` runs
// the channel's reference agent a second time as `coder`, with its own tokens and request URL.
slackChecks({
  app: "coder",
  streamPrompt: "write a long report on Q3",
  approval: { prompt: "@coder deploy web to staging", button: "Approve" },
  ...onlyFromEnv(SLACK_CHECKS),
});
