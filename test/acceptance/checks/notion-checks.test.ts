import { NOTION_CHECKS, notionChecks } from "../../../integrations/checks/index.ts";
import { onlyFromEnv } from "./only.ts";

// Exit check 4.5: the standard checks, as a developer adds them to a suite. `scripts/examples.ts`
// runs this file against each Notion reference agent, and `test/acceptance/checks-broken.test.ts`
// runs it against an agent with one fault per check.
notionChecks({ app: "my-agent", ...onlyFromEnv(NOTION_CHECKS) });
