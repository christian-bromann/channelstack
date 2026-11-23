/**
 * A Notion integration on Notion's own SDK, written the way Notion's webhook guide shows: the
 * subscription's verification request answered, every event checked with
 * `verifyWebhookSignature`, and the rest through `Client`. It is configured from the environment
 * `channelstack env` prints and talks to whatever `NOTION_BASE_URL` points at: the fake in tests,
 * Notion itself when the variable is unset. It has no channelstack code in it.
 */
import notionClient from "@notionhq/client";

import { notionAgent } from "../shared/notion.ts";
import { serve } from "../shared/serve.ts";

// The package is CommonJS: Node gives it to an ES module as its default export.
const { Client, verifyWebhookSignature } = notionClient;
const { NOTION_TOKEN, NOTION_VERIFICATION_TOKEN, NOTION_BASE_URL, PORT } = process.env;
if (!NOTION_TOKEN || !NOTION_VERIFICATION_TOKEN || !PORT) {
  throw new Error("The agent needs NOTION_TOKEN, NOTION_VERIFICATION_TOKEN and PORT");
}

const notion = new Client({ auth: NOTION_TOKEN, ...(NOTION_BASE_URL ? { baseUrl: NOTION_BASE_URL } : {}) });
const agent = notionAgent(notion);

serve(Number(PORT), "/webhooks/notion", async (request, body) => {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const event = JSON.parse(body) as Parameters<typeof agent.handle>[0] & { verification_token?: string };
  // The one request Notion sends when the subscription is made: it carries the token to paste into the settings.
  if (typeof event.verification_token === "string") {
    console.log("Notion sent the verification token for this subscription");
    return new Response(null, { status: 200 });
  }
  const signature = request.headers.get("x-notion-signature");
  if (!(await verifyWebhookSignature({ body, signature, verificationToken: NOTION_VERIFICATION_TOKEN })))
    return new Response("invalid signature", { status: 401 });
  // Notion wants an answer within seconds; the work happens after it.
  agent.handle(event).catch((error: unknown) => console.error("The agent failed:", error));
  return new Response(null, { status: 200 });
});
