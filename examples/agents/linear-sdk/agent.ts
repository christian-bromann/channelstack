/**
 * A Linear agent on Linear's own SDK, written the way Linear's agent guide shows: webhooks through
 * `LinearWebhookClient`, everything else through `LinearClient`. It is configured from the
 * environment `channelstack env` prints and talks to whatever `LINEAR_API_URL` points at: the fake
 * in tests, Linear itself when the variable is unset. It has no channelstack code in it.
 */
import { LinearClient } from "@linear/sdk";
import { LinearWebhookClient } from "@linear/sdk/webhooks";

import { linearAgent } from "../shared/linear.ts";
import { serve } from "../shared/serve.ts";

const { LINEAR_ACCESS_TOKEN, LINEAR_WEBHOOK_SECRET, LINEAR_API_URL, PORT } = process.env;
if (!LINEAR_ACCESS_TOKEN || !LINEAR_WEBHOOK_SECRET || !PORT) {
  throw new Error("The agent needs LINEAR_ACCESS_TOKEN, LINEAR_WEBHOOK_SECRET and PORT");
}

const linear = new LinearClient({
  accessToken: LINEAR_ACCESS_TOKEN,
  ...(LINEAR_API_URL ? { apiUrl: LINEAR_API_URL } : {}),
});
const agent = linearAgent(linear);

const handler = new LinearWebhookClient(LINEAR_WEBHOOK_SECRET).createHandler();
handler.on("AgentSessionEvent", (event) => {
  const { agentSession: session, agentActivity: activity } = event;
  const issueId = session.issueId ?? session.issue?.id;
  if (event.action === "created" && issueId) agent.created(session.id, issueId);
  if (event.action === "prompted" && activity) {
    const body = "body" in activity.content ? String(activity.content.body ?? "") : "";
    agent.prompted(session.id, { body, stop: activity.signal === "stop" });
  }
});

serve(Number(PORT), "/webhooks/linear", (request) => handler(request));
