import { TWILIO_CHECKS, twilioChecks } from "../../../integrations/checks/index.ts";
import { onlyFromEnv } from "./only.ts";

// Exit check 10.4: the standard checks, as a developer adds them to a suite. `scripts/examples.ts`
// runs this file against the Twilio reference agent, and `test/acceptance/checks-broken.test.ts`
// runs it against an agent with one fault per check.
twilioChecks({ app: "my-agent", ...onlyFromEnv(TWILIO_CHECKS) });
