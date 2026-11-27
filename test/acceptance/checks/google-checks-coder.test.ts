import { GOOGLE_CHECKS, googleChecks } from "../../../integrations/checks/index.ts";
import { onlyFromEnv } from "./only.ts";

// Exit check 12.7: the same checks against another app (decision 0027). `scripts/examples.ts` runs
// the channel's reference agent a second time as `coder`, with its own mailbox, key and webhook.
googleChecks({ app: "coder", ...onlyFromEnv(GOOGLE_CHECKS) });
