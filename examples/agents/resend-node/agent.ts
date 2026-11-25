/**
 * A Resend agent on Resend's own SDK, written the way Resend's guides show: every webhook checked
 * with `resend.webhooks.verify`, a received email read back with `resend.emails.receiving.get`,
 * and the answer sent with `resend.emails.send`, `In-Reply-To` and `References` set. It is
 * configured from the environment `channelstack env` prints and talks to whatever
 * `RESEND_BASE_URL` points at: the fake in tests, Resend itself when the variable is unset. It
 * has no channelstack code in it.
 */
import { Resend } from "resend";

import { resendAgent } from "../shared/resend.ts";
import { serve } from "../shared/serve.ts";

const { RESEND_API_KEY, RESEND_WEBHOOK_SECRET, PORT } = process.env;
if (!RESEND_API_KEY || !RESEND_WEBHOOK_SECRET || !PORT) {
  throw new Error("The agent needs RESEND_API_KEY, RESEND_WEBHOOK_SECRET and PORT");
}

// The SDK reads RESEND_BASE_URL itself.
const resend = new Resend(RESEND_API_KEY);
const agent = resendAgent(resend);

serve(Number(PORT), "/webhooks/resend", async (request, body) => {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  let event: Parameters<typeof agent.handle>[0];
  try {
    event = resend.webhooks.verify({
      payload: body,
      headers: {
        id: request.headers.get("svix-id") ?? "",
        timestamp: request.headers.get("svix-timestamp") ?? "",
        signature: request.headers.get("svix-signature") ?? "",
      },
      webhookSecret: RESEND_WEBHOOK_SECRET,
    }) as Parameters<typeof agent.handle>[0];
  } catch {
    return new Response("invalid signature", { status: 400 });
  }
  // Resend wants an answer within seconds; the work happens after it.
  agent.handle(event).catch((error: unknown) => console.error("The agent failed:", error));
  return new Response(null, { status: 200 });
});
