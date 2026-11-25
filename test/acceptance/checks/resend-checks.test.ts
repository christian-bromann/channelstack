import { RESEND_CHECKS, resendChecks } from "../../../integrations/checks/index.ts";
import { onlyFromEnv } from "./only.ts";

// Exit check 8.5: the standard checks, as a developer adds them to a suite. `scripts/examples.ts`
// runs this file against the Resend reference agent, and `test/acceptance/checks-broken.test.ts`
// runs it against an agent with one fault per check.
resendChecks({ app: "my-agent", ...onlyFromEnv(RESEND_CHECKS) });
