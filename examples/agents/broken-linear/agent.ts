/**
 * A Linear agent with one switchable fault per standard check. With `BROKEN` unset it does
 * everything right; with `BROKEN=linear.stop` (any check id) it has exactly the bug that check
 * exists to catch. The test suite uses it to prove that each check fails when it should.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { LinearClient } from "@linear/sdk";
import { type AgentSessionEventWebhookPayload, LinearWebhookClient } from "@linear/sdk/webhooks";

import { serve } from "../shared/serve.ts";

const { LINEAR_ACCESS_TOKEN, LINEAR_WEBHOOK_SECRET, LINEAR_API_URL, PORT } = process.env;
if (!LINEAR_ACCESS_TOKEN || !LINEAR_WEBHOOK_SECRET || !PORT) {
  throw new Error("The agent needs LINEAR_ACCESS_TOKEN, LINEAR_WEBHOOK_SECRET and PORT");
}
const fault = process.env.BROKEN ?? "";
const broken = (check: string) => fault === check;

const linear = new LinearClient({
  accessToken: LINEAR_ACCESS_TOKEN,
  ...(LINEAR_API_URL ? { apiUrl: LINEAR_API_URL } : {}),
});
const webhooks = new LinearWebhookClient(LINEAR_WEBHOOK_SECRET);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (agentSessionId: string, type: "thought" | "response", body: string) =>
  linear.createAgentActivity({ agentSessionId, content: { type, body } });

/** The signature alone, without the timestamp in the body: what a hand-rolled receiver checks. */
const signedOnly = (raw: string, signature: string) => {
  const expected = Buffer.from(createHmac("sha256", LINEAR_WEBHOOK_SECRET).update(raw).digest("hex"));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

/** Is this webhook from Linear? */
function verified(raw: string, signature: string): AgentSessionEventWebhookPayload | undefined {
  // Bug: trusts whoever posts to its endpoint.
  if (broken("linear.bad-signature")) return JSON.parse(raw);
  // Bug: checks the signature but not how old the webhook is.
  if (broken("linear.stale")) return signedOnly(raw, signature) ? JSON.parse(raw) : undefined;
  try {
    return webhooks.parseData(Buffer.from(raw), signature) as AgentSessionEventWebhookPayload;
  } catch {
    return undefined;
  }
}

const started = new Set<string>();

async function work(session: string) {
  // Bug: thinks for a long time before it says anything.
  if (broken("linear.first-activity")) await pause(12_000);
  await say(session, "thought", "Looking into it");
  // With the Stop fault the job is a long one, and Stop doesn't cut it short.
  await pause(broken("linear.stop") ? 20_000 : 300);
  // Bug: never ends its turn.
  if (broken("linear.ends-turn")) return;
  await say(session, "response", "Done.");
}

const me = linear.viewer.then((viewer) => viewer.id);

/** A comment on an issue. A correct agent leaves other apps' comments alone; this one doesn't, with its fault. */
async function commented(comment: { issueId?: string; userId?: string }) {
  if (!comment.issueId || comment.userId === (await me)) return;
  await linear.createComment({ issueId: comment.issueId, body: "On it." });
}

serve(Number(PORT), "/webhooks/linear", async (request, body) => {
  const event = verified(body, request.headers.get("linear-signature") ?? "");
  if (!event) return new Response("invalid webhook", { status: 400 });
  const raw = event as unknown as { type: string; action: string; data: { issueId?: string; userId?: string } };
  // Bug: answers every comment, another app's included, so two apps answer each other without end.
  if (raw.type === "Comment" && raw.action === "create" && broken("linear.no-reply-loop")) {
    commented(raw.data).catch((error: unknown) => console.error("The agent failed:", error));
    return new Response(null, { status: 200 });
  }
  if (event.type !== "AgentSessionEvent") return new Response(null, { status: 200 });
  const session = event.agentSession.id;
  if (event.action === "created") {
    // Bug: takes a redelivery for a new session.
    if (started.has(session) && !broken("linear.redelivery")) return new Response(null, { status: 200 });
    started.add(session);
    work(session).catch((error: unknown) => console.error("The agent failed:", error));
  }
  // Bug: doesn't listen to Stop.
  if (event.action === "prompted" && event.agentActivity?.signal === "stop" && !broken("linear.stop"))
    say(session, "response", "Stopped.").catch((error: unknown) => console.error("The agent failed:", error));
  return new Response(null, { status: 200 });
});
