import { GITHUB_CHECKS, githubChecks } from "../../../integrations/checks/index.ts";
import { onlyFromEnv } from "./only.ts";

// Exit check 12.7: the same checks against another App (decision 0027). `scripts/examples.ts` runs
// the channel's reference agent a second time as `coder`, with its own key, secret and webhook.
githubChecks({ app: "coder", ...onlyFromEnv(GITHUB_CHECKS) });
