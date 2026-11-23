/**
 * A reference agent: a Linear agent on the Chat SDK and its Linear adapter in agent-session mode,
 * as a developer would write it. A session (a delegation or a mention) arrives as a new mention, a
 * person's prompt as a message in the subscribed thread, and the answer is posted to the thread;
 * the rest (thoughts, plans, states) goes through a `LinearClient` of the app's own (the adapter
 * pins an older `@linear/sdk`, so its client is a different type). It behaves like
 * the `@linear/sdk` reference agent and has no channelstack code in it. Configuration comes from
 * the environment (`channelstack env`).
 */
import { createLinearAdapter } from "@chat-adapter/linear";
import { createMemoryState } from "@chat-adapter/state-memory";
import { LinearClient } from "@linear/sdk";
import { Chat, type Thread } from "chat";

import { linearAgent } from "../shared/linear.ts";
import { serve } from "../shared/serve.ts";

const { LINEAR_ACCESS_TOKEN, LINEAR_WEBHOOK_SECRET, LINEAR_API_URL, PORT } = process.env;
if (!LINEAR_ACCESS_TOKEN || !LINEAR_WEBHOOK_SECRET || !PORT) {
  throw new Error("The agent needs LINEAR_ACCESS_TOKEN, LINEAR_WEBHOOK_SECRET and PORT");
}

const linear = createLinearAdapter({ mode: "agent-sessions", accessToken: LINEAR_ACCESS_TOKEN, userName: "my-agent" });
const bot = new Chat({ userName: "my-agent", adapters: { linear }, state: createMemoryState(), logger: "warn" });

/** The session threads the agent answers in, by session id. */
const threads = new Map<string, Thread>();
const client = new LinearClient({
  accessToken: LINEAR_ACCESS_TOKEN,
  ...(LINEAR_API_URL ? { apiUrl: LINEAR_API_URL } : {}),
});
const agent = linearAgent(client, (sessionId, body) => {
  const thread = threads.get(sessionId);
  if (!thread) throw new Error(`No thread for session ${sessionId}`);
  return thread.post(body);
});

bot.onNewMention(async (thread) => {
  const { issueId, agentSessionId } = linear.decodeThreadId(thread.id);
  if (!agentSessionId) return;
  threads.set(agentSessionId, thread);
  await thread.subscribe();
  agent.created(agentSessionId, issueId);
});

bot.onSubscribedMessage(async (thread, message) => {
  const { agentSessionId } = linear.decodeThreadId(thread.id);
  if (!agentSessionId) return;
  threads.set(agentSessionId, thread);
  // Stop comes as a prompt with the `stop` signal, which the message doesn't carry: the activity does.
  const activity = await client.agentActivity(message.id).catch(() => undefined);
  agent.prompted(agentSessionId, { body: message.text, stop: activity?.signal === "stop" });
});

serve(Number(PORT), "/api/webhooks/linear", (request) => bot.webhooks.linear(request));
