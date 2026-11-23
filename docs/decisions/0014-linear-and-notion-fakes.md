# 0014: The Linear and Notion fakes

Status: accepted, phase 4.

## Linear: GraphQL on Linear's own schema

The fake executes GraphQL with `graphql-js` against Linear's schema, committed as `server/src/drivers/linear/schema/schema.graphql` from `linear/linear` at a pinned commit. `scripts/linear-schema.ts` writes the module the binary embeds and checks it in the gate; `--fetch` takes a new commit.

- **Resolvers return model objects, not hand-written answers per query.** A field the fake has no value for gets Linear's empty value for its type (an empty list, `false`, `null` where the schema allows it). A non-null object the fake doesn't model is an error naming it ("The fake has no Issue.sharedAccess"), so a gap shows up as a failing call, never as an invented value. The official SDK selects every scalar of a type in its queries, so a reference agent on `@linear/sdk` exercises much more of the schema than the examples ask for.
- **Every answer is checked against the schema** in the unit tests and, for the whole acceptance run, by `test/acceptance/linear-schemas.setup.ts` (exit check 4.3). Webhook payloads are checked against the schema's `*WebhookPayload` types, which have no `__typename`: a union member is the one the payload fits.
- **Errors are Linear's:** `extensions.code` `INPUT_ERROR`, `FORBIDDEN` or `AUTHENTICATION_ERROR`, with `type`, `userError` and `userPresentableMessage`; 401 for a missing or wrong token, 400 for a query that doesn't parse or validate.

Alternative: hand-written resolvers per operation the examples use. Rejected: an agent on the real SDK sends operations nobody listed, and the first one would fail in a way the platform never does.

## Linear: sessions and activities

The session rules come from the schema's descriptions and Linear's agent guide: created → `pending`; a thought or action → `active`; an elicitation → `awaitingInput`; a response ends the turn (`complete`, or `active` with the `continue` signal); an error → `error`. A person's prompt starts a new turn (`pending`); Stop is a prompt with the `stop` signal and makes the session `stopping` until the agent's response or error. Only the app publishes activities; prompt activities and the `stop` signal are refused from it.

- **What a person has to read is also a comment.** An agent's `response`, `elicitation` and `error` are written as comments of the app in the session's thread: the mention it started from, or for a delegation a thread of its own that its first such comment opens. The activity's `sourceComment` is that comment, and a reply there prompts the session. This is an inference: Vercel's Chat SDK adapter, written against real Linear, requires a response activity to have a source comment. The reality matrix marks it unverified until the first live run.
- **`waitForActivity` answers the latest prompt.** A `next` wait on a fresh handle starts from the first item; for a session that would return the answer to an earlier prompt. The wait binding gained `turn` (`x-channelstack-waits`): an item of that kind (a person's prompt) starts a new turn, and the wait looks only after the newest. Both SDK runtimes have it.

## Linear: webhooks

`Linear-Signature` is the hex HMAC-SHA256 of the body with the webhook secret, and the body carries `webhookTimestamp`, which receivers check (more than a minute off is refused). The delivery queue gained `stamp`: each attempt (a retry, a redelivery) writes its own time into the body and is signed over those bytes. A stale resend stamps a time two minutes back. Retries follow Linear's schedule (a minute, an hour, six hours).

## Notion: the REST surface at `2025-09-03`

The fake serves what `@notionhq/client` calls at its default version: users, pages, page properties, blocks and their children, databases and data sources (2025-09-03 splits them), data source queries, search, comments. Requests need the integration's token and a `Notion-Version`; answers and errors have Notion's shapes (`object: "error"`, `code`, `request_id`; `object: "list"` with cursors).

- **The builders are typed by the client's own response and webhook types** (`objects.ts`, `payloads.ts`), so a field Notion has and the fake forgot is a type error. `@notionhq/client` is a dev dependency of the server for its types only.
- **Connections decide everything.** The integration sees a page or database it is connected to, or one under such a page; anything else is `object_not_found` with Notion's hint about sharing, and sends no event. Rows inherit from their database.
- **A child page is a `child_page` block of its parent, with the page's own id,** as in Notion, so walking a page's children finds its subpages.
- **Markdown is read with `marked`'s lexer** into Notion's blocks (headings, paragraphs, bulleted, numbered and to-do items with nesting, code, quotes, dividers; bold, italic, strikethrough, code and links in rich text), and blocks read back as Markdown. Nothing is rendered to HTML.
- **A resolved discussion leaves the API's lists,** as Notion's "un-resolved comments" are all `comments.list` returns.

## Notion: webhooks

Events are sparse, as Notion's are: the entity, its parent, who did it (`authors`), and for content updates the blocks; the agent reads the rest. `X-Notion-Signature` is `sha256=` and the HMAC of the body with the subscription's verification token; `attempt_number` is stamped per attempt.

- **`page.content_updated` is batched:** the first edit of a page starts a delay (one second by default, `notion.setContentUpdateDelay(delay)` per test), and one event names every block changed meanwhile. A batch on its way is open work for the quiet detector.
- **The integration's own changes come back as events,** with the bot in `authors`. Notion's documentation doesn't say either way; an agent has to ignore its own comments regardless, and the checks hold it to that. Unverified.
- **The verification request is sent on demand** (`notion.sendVerification()`), not at start: Notion sends it once, when a subscription is created, and the agent then holds the token (`NOTION_VERIFICATION_TOKEN` from `channelstack env`).

## Reference agents

- Linear: `@linear/sdk` (`LinearWebhookClient`, `LinearClient`) and the Chat SDK's Linear adapter in agent-session mode, sharing their behaviour in `examples/agents/shared/linear.ts`.
- Notion: `@notionhq/client` (`verifyWebhookSignature`, `Client`). The Chat SDK's Notion adapter isn't used: it calls `https://api.notion.com/v1` with no way to set the base URL, so it can reach the fake only in proxy mode (phase 5).

## Shared changes

- **The registry lists a session's objects in creation order** (`Collection.list`, `values`). The Linear and Notion stores use it instead of keeping their own index; the GitHub store still has its own (numeric ids) and can move to it later.
- **Slack's `ts` increases across the world,** not per conversation, so "the conversation with the newest message" doesn't depend on random digits within one millisecond.
- **The Vitest fixtures are fixtures.** `channelstack`, `slack`, `github`, `linear` and `notion` are registered with `test.override` as automatic fixtures, so a suite's `test.extend` can build on them (`api/examples/fixtures.ts`). Hooks and checks destructure the context, as Vitest requires once fixtures exist.
