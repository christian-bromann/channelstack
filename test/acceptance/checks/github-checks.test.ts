import { GITHUB_CHECKS, githubChecks } from "../../../integrations/checks/index.ts";
import { onlyFromEnv } from "./only.ts";

// Exit check 3.4: the standard checks, as a developer adds them to a suite. `scripts/examples.ts`
// runs this file against each GitHub reference agent, and `test/acceptance/checks-broken.test.ts`
// runs it against an agent with one fault per check.
githubChecks({ app: "my-agent", ...onlyFromEnv(GITHUB_CHECKS) });
