import { DISCORD_CHECKS, discordChecks } from "../../../integrations/checks/index.ts";
import { onlyFromEnv } from "./only.ts";

// Exit check 12.7: the same checks against another app (decision 0027). `scripts/examples.ts` runs
// the channel's reference agent a second time as `coder`, with its own bot token and interactions endpoint.
discordChecks({
  app: "coder",
  command: "/deploy web",
  longPrompt: "write a long report on Q3",
  ...onlyFromEnv(DISCORD_CHECKS),
});
