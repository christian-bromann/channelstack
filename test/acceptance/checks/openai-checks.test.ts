import { SLACK_CHECKS, SLACK_MODEL_CHECKS, slackChecks } from "../../../integrations/checks/index.ts";
import { onlyFromEnv } from "./only.ts";

// Exit check 13.9: the standard Slack checks of an agent on the fake OpenAI, as a developer adds
// them: the checks script the model, and the model checks are added. `scripts/examples.ts` runs this
// file against each OpenAI agent, and `test/acceptance/checks-broken.test.ts` runs its model checks
// against the agent with one fault per check.
slackChecks({ app: "my-agent", model: "openai", ...onlyFromEnv([...SLACK_CHECKS, ...SLACK_MODEL_CHECKS]) });
