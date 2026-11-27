/**
 * A Notion integration with one switchable fault per standard check. With `BROKEN` unset it does
 * everything right; with `BROKEN=notion.redelivery` (any check id) it has exactly the bug that
 * check exists to catch. The test suite uses it to prove that each check fails when it should.
 */
import notionClient from "@notionhq/client";

import { serve } from "../shared/serve.ts";

// The package is CommonJS: Node gives it to an ES module as its default export.
const { Client, verifyWebhookSignature } = notionClient;
const { NOTION_TOKEN, NOTION_VERIFICATION_TOKEN, NOTION_BASE_URL, PORT } = process.env;
if (!NOTION_TOKEN || !NOTION_VERIFICATION_TOKEN || !PORT) {
  throw new Error("The agent needs NOTION_TOKEN, NOTION_VERIFICATION_TOKEN and PORT");
}
const fault = process.env.BROKEN ?? "";
const broken = (check: string) => fault === check;

const notion = new Client({ auth: NOTION_TOKEN, ...(NOTION_BASE_URL ? { baseUrl: NOTION_BASE_URL } : {}) });
const me = notion.users.me({}).then((user) => user.id);
const text = (content: string) => [{ type: "text" as const, text: { content } }];

/** Events handled, by id; and how often it answered in each discussion, so the loop a fault starts ends. */
const handled = new Set<string>();
const answered = new Map<string, number>();

type Event = {
  id: string;
  type: string;
  authors: Array<{ id: string; type?: string }>;
  entity: { id: string };
  data: { page_id: string; discussion_id: string };
};

async function commentCreated(event: Event) {
  const self = await me;
  const own = event.authors.every((author) => author.id === self);
  const discussion = event.data.discussion_id;
  // Bug: answers every comment, its own included (three times, then it stops, so the test ends).
  if (own && !(broken("notion.ignores-own-comments") && (answered.get(discussion) ?? 0) < 3)) return;
  // Bug: answers another integration's comments too, so two integrations answer each other without end.
  if (!own && event.authors.some((author) => author.type === "bot") && !broken("notion.no-reply-loop")) return;
  answered.set(discussion, (answered.get(discussion) ?? 0) + 1);
  // Bug: answers in a new discussion on the page, not where it was asked.
  if (broken("notion.reply-in-discussion"))
    await notion.comments.create({ parent: { page_id: event.data.page_id }, rich_text: text("Hi!") });
  else await notion.comments.create({ discussion_id: discussion, rich_text: text("Hi!") });
}

serve(Number(PORT), "/webhooks/notion", async (request, body) => {
  const event = JSON.parse(body) as Event & { verification_token?: string };
  if (typeof event.verification_token === "string") return new Response(null, { status: 200 });
  const signature = request.headers.get("x-notion-signature");
  // Bug: trusts whoever posts to its endpoint.
  const trusted =
    broken("notion.bad-signature") ||
    (await verifyWebhookSignature({ body, signature, verificationToken: NOTION_VERIFICATION_TOKEN }));
  if (!trusted) return new Response("invalid signature", { status: 401 });
  // Bug: takes an event sent again for a new one.
  if (handled.has(event.id) && !broken("notion.redelivery")) return new Response(null, { status: 200 });
  handled.add(event.id);
  if (event.type === "comment.created")
    commentCreated(event).catch((error: unknown) => console.error("The agent failed:", error));
  return new Response(null, { status: 200 });
});
