import { GOOGLE_CHECKS, googleChecks } from "../../../integrations/checks/index.ts";
import { onlyFromEnv } from "./only.ts";

// Exit check 9.4: the standard checks, as a developer adds them to a suite. `scripts/examples.ts`
// runs this file against the Gmail reference agent, and `test/acceptance/checks-broken.test.ts`
// runs it against an agent with one fault per check.
googleChecks({ app: "my-agent", ...onlyFromEnv(GOOGLE_CHECKS) });
