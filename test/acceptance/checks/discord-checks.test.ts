import { DISCORD_CHECKS, discordChecks } from "../../../integrations/checks/index.ts";
import { onlyFromEnv } from "./only.ts";

// Exit check 11.4: the standard checks, as a developer adds them to a suite. `scripts/examples.ts`
// runs this file against the Discord reference agent, and `test/acceptance/checks-broken.test.ts`
// runs it against an agent with one fault per check.
discordChecks({
  app: "my-agent",
  command: "/deploy web",
  longPrompt: "write a long report on Q3",
  ...onlyFromEnv(DISCORD_CHECKS),
});
