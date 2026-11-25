---
title: "Notion"
order: 4
description: "Test a Notion integration against channelstack's fake Notion, from connecting @notionhq/client to comments, discussions, page edits, database rows and connections."
---

# Notion

This page shows how to test an integration built on Notion's API: how to point it at the fake, which people, pages and databases a test creates, what those people do, and what you check afterwards. It assumes you have run [Getting started](/docs/getting-started) once.

> [!TIP]
> Every method, option and wait of the Notion fake, with each call in TypeScript, Python and Rust, is in the [Notion API reference](/docs/reference/api/notion).

```ts title="comments.test.ts"
import { test, expect } from "vitest";

test("a mention in a page comment gets a reply in the same discussion", async ({ notion }) => {
  const ana = await notion.createUser({ name: "Ana" });
  const page = await notion.createPage({
    title: "Roadmap",
    content: "# Q1\n- ship search\n- ship billing",
    connections: [notion.app],
  });

  const comment = await ana.comment("@my-agent summarize this page", { page });

  await expect(comment.discussion).toHaveCommentFrom("my-agent", { text: /search/i });
  await expect(comment.discussion).toHaveCommentsFrom(notion.app, { count: 1 });
});
```

## What the fake covers

The fake Notion is one workspace with one internal integration in it, `my-agent`. It serves the REST API that `@notionhq/client` calls at its default version, `2025-09-03`, and sends the integration's webhooks.

| Area | What's there |
|---|---|
| Users | `users.me`, `users.list`, `users.retrieve` |
| Pages | `pages.create`, `retrieve`, `update`, `pages.properties.retrieve` |
| Blocks | `blocks.retrieve`, `update`, `delete`, `blocks.children.list` and `append` |
| Databases | `databases.retrieve`, `dataSources.retrieve`, `dataSources.query` (`2025-09-03` splits databases into data sources) |
| Search and comments | `search`, `comments.list`, `retrieve`, `create` (on a page, a block or in a discussion) |
| Webhooks | `page.created`, `page.content_updated`, `page.properties_updated`, `comment.created`, `comment.updated`, `comment.deleted`, and the verification request |

The integration has every capability: read, update and insert content, read and insert comments, read user information. Answers and errors have Notion's shapes (`object: "list"` with cursors, `object: "error"` with `code` and `request_id`). A child page is a `child_page` block of its parent, so walking a page's children finds its subpages. A resolved discussion leaves `comments.list`, as on Notion.

Page content is written and read as Markdown: headings, paragraphs, bulleted, numbered and to-do items with nesting, code, quotes and dividers, with bold, italic, strikethrough, code and links inside. You can also pass raw block objects.

Not covered: creating or changing databases and data sources through the API, moving or trashing pages, file uploads, views, and editing or deleting comments as the integration. A path the fake doesn't serve answers `invalid_request_url`.

## Connecting a Notion integration

Ask the running server for the integration's settings:

```bash
npx channelstack env
```

```ini
NOTION_BASE_URL=https://notion.localhost
NOTION_TOKEN=ntn_…
NOTION_VERIFICATION_TOKEN=…
```

The token and verification token are random, made once for your machine and kept in `~/.channelstack/secrets.json`. With `--no-portless`, the URL is `http://127.0.0.1:4500/notion`.

### `@notionhq/client`

```ts title="agent.ts"
import notionClient from "@notionhq/client";

// The package is CommonJS: Node gives it to an ES module as its default export.
const { Client, verifyWebhookSignature } = notionClient;

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  ...(process.env.NOTION_BASE_URL ? { baseUrl: process.env.NOTION_BASE_URL } : {}),
});

export async function handle(request: Request): Promise<Response> {
  const body = await request.text();
  const event = JSON.parse(body);
  // The one request Notion sends when the subscription is made.
  if (typeof event.verification_token === "string") return new Response(null, { status: 200 });

  const ok = await verifyWebhookSignature({
    body,
    signature: request.headers.get("x-notion-signature"),
    verificationToken: process.env.NOTION_VERIFICATION_TOKEN!,
  });
  if (!ok) return new Response("invalid signature", { status: 401 });

  void work(event); // answer within seconds, work after
  return new Response(null, { status: 200 });
}
```

`baseUrl` is the host without `/v1`: the client adds the path. Leave `NOTION_BASE_URL` unset in production, where the client talks to `https://api.notion.com`. Every request needs a `Notion-Version` header, which the client sends; the fake takes `2022-06-28`, `2025-09-03` and `2026-03-11`.

The Chat SDK's Notion adapter isn't covered in base-URL mode: it calls `https://api.notion.com/v1` with no way to set the base URL. Run an agent on it in [proxy mode](/docs/guide/proxy-mode).

### Where webhooks are delivered

channelstack sends the integration's webhooks to the URL you give it when the server starts:

```bash
CHANNELSTACK_NOTION_WEBHOOK_URL=http://localhost:3000/webhooks/notion npx channelstack start
```

`/webhooks/notion` is the path the reference agent serves. Without a webhook URL, nothing is delivered. Notion sends the verification request once, when a subscription is created; the fake sends it only when a test asks, with `notion.sendVerification()`, because `channelstack env` already hands the agent the token. See [Connecting your agent](/docs/guide/connecting-your-agent) for TLS trust and the other runtimes.

## People, pages and databases in a test

A test creates the people, pages and databases it needs. Nothing is declared in a config file.

```ts
const ana = await notion.createUser({ name: "Ana" });
const ben = await notion.createUser({ name: "Ben", email: "ben@example.com" });
```

| Option | What it does |
|---|---|
| `name` | Required. Mentions (`@Ana`) and matchers find the person by it |
| `id` | A fixed id (a UUID), for agents that allowlist by id |
| `email`, `avatarUrl` | Profile fields `users.retrieve` returns |
| `token` | Live mode only: see [Live](#live) |

### Pages

```ts
const space = await notion.createPage({ title: "Engineering", connections: [notion.app] });
const spec = await notion.createPage({
  title: "Spec",
  parent: space,
  content: { path: "./fixtures/spec.md" },
  icon: "📐",
});
```

`notion.createPage` makes seed data: it sends no event. Use `ana.createPage(...)` when the creation itself should reach the agent as `page.created`.

| Option | What it does |
|---|---|
| `title` | Required |
| `parent` | Another page. Without one, the page is at the top of the workspace |
| `content` | Markdown, `{ path }` to a `.md` fixture relative to the test file, or raw Notion block objects |
| `icon` | An emoji |
| `connections` | Integrations connected to the page |
| `createdBy` | Who's shown as the creator. Default: a generated workspace owner |

### Databases

```ts
const tasks = await notion.createDatabase({
  title: "Tasks",
  properties: { Name: "title", Status: { status: ["Todo", "Ready for agent", "Done"] }, Estimate: "number" },
  rows: [{ Name: "Write the onboarding guide", Status: "Todo" }],
  connections: [notion.app],
});
const [row] = await tasks.rows({ Name: "Write the onboarding guide" });
```

Property types are `title`, `rich_text`, `number`, `checkbox`, `date`, `people`, `url`, `email`, `{ select: [...] }`, `{ multi_select: [...] }`, `{ status: [...] }` and `{ relation: database }`. A row is a page, so everything a page can do, a row can do.

### Giving the integration access

The integration sees a page or database only when it's connected to it, or to a page above it, which is Notion's rule. Rows inherit from their database. Anything else answers `object_not_found` (with Notion's hint about sharing) and sends no event:

```ts
const notes = await notion.createPage({ title: "Private notes" }); // not connected
const comment = await ana.comment("@my-agent read this", { page: notes });
expect(comment.delivery).toBeUndefined();

await ana.connect(notion.app, { page: notes });
```

`connect` and `disconnect` are Share → Connections in Notion: a person adds or removes the integration on a page. They send no event, as on Notion.

## What people do

Every action is a method on the person who takes it, with the content first and the place as an option. An action that sends one webhook resolves to that delivery. The [API reference](/docs/reference/api/notion) lists every method and option.

### Comments and discussions

```ts
const comment = await ana.comment("@my-agent is this enough for the mobile app?", { page, anchor: "Rate limits" });
await comment.discussion.waitForComment({ from: notion.app });

await ana.reply("@my-agent and what should we change?", { discussion: comment.discussion });
await ana.editComment("@my-agent is this enough for the iOS app?", { comment });
await ana.resolve({ discussion: comment.discussion });
```

`comment` starts a discussion: on the page, or with `anchor` (a string or a `RegExp`) on the block whose text matches. It sends `comment.created` and resolves to the comment; its discussion is `comment.discussion`, and `discussion.anchor` the text it's anchored to. `reply` adds to a discussion, `editComment` and `deleteComment` send `comment.updated` and `comment.deleted`, and `resolve` and `reopen` change the discussion without an event. `@name` becomes a real mention.

### Page edits and mentions

```ts
await ana.edit({ append: "## Open questions\n- who owns billing?" }, { page });
await ana.edit({ replace: "# Draft\nStarting over." }, { page });
await ana.rename("Spec v2", { page });
await ana.mention(notion.app, { page, inBlock: "TODO" });
```

`edit` appends to or replaces the body (Markdown or blocks) and sends `page.content_updated`. `mention` puts a mention of the integration inside the page body, in the block whose text matches `inBlock` or in a new paragraph, which is also a content update. `rename` changes the title property and sends `page.properties_updated`.

Content updates are batched, as on Notion: the first edit of a page starts a delay (one second by default), and one event names every block changed meanwhile. A batch on its way counts as open work, so the agent isn't quiet until it's sent. `notion.setContentUpdateDelay("3s")` changes the delay for one test.

### Pages, rows and properties

```ts
const report = await ana.createPage({ title: "Checkout outage", parent: space, content: "Started 09:12 UTC" });

const row = await ana.addRow({ Name: "Migrate to Postgres 17", Status: "Todo" }, { database: tasks });
await ana.setProperty("Status", "Ready for agent", { page: row });
```

`ana.createPage` and `addRow` send `page.created`; `setProperty` sends `page.properties_updated`.

## What to check

The matchers read pages and discussions as the agent last left them. Positive matchers resolve as soon as the condition holds; `.not` and exact counts wait until the agent is quiet first. [Waiting and quiet](/docs/guide/waiting-and-quiet) explains how.

| Matcher | Subject | Reads |
|---|---|---|
| `toHaveCommentFrom(author, { text })` | discussion | `discussion.comments()` |
| `toHaveCommentsFrom(author, { count })` | discussion | `discussion.comments()`, once quiet |
| `toHaveBlock(text)` | page | `page.markdown()`, `page.blocks()` |
| `toHavePropertyValue(name, value)` | page (a row) | `page.property(name)` |
| `toContainText(text)` | page, discussion | `transcript()` |
| `toBeAccepted`, `toBeRejected`, `toBeRetried` | delivery | `delivery.attempts` |
| `toHaveReceivedCall(operation, { times, error })` | `notion` | `notion.calls()` |

`toHavePropertyValue` takes Vitest's asymmetric matchers: `toHavePropertyValue("Estimate", expect.any(Number))`.

The reads behind them: `page.markdown()`, `page.blocks()`, `page.discussions()`, `page.children()`, `page.connections()`, `page.property(name)`, `database.rows(filter)`, `discussion.comments()`, `discussion.latestComment({ from })` and `discussion.resolved()`. `notion.calls()` names each call by the client's method, such as `comments.create` or `blocks.children.append`.

A full test, a person adds a row and asks the integration to fill in a property:

```ts title="rows.test.ts"
import { test, expect } from "vitest";

test("database rows: the agent fills in a property", async ({ notion }) => {
  const ana = await notion.createUser({ name: "Ana" });
  const tasks = await notion.createDatabase({
    title: "Tasks",
    properties: { Name: "title", Status: { status: ["Todo", "In progress", "Done"] }, Estimate: "number" },
    connections: [notion.app],
  });

  const row = await ana.addRow({ Name: "Migrate to Postgres 17", Status: "Todo" }, { database: tasks });
  const comment = await ana.comment("@my-agent estimate this", { page: row });

  await expect(row).toHavePropertyValue("Estimate", expect.any(Number));
  await expect(comment.discussion).toHaveCommentsFrom(notion.app, { count: 1 });
  await expect(notion).toHaveReceivedCall("pages.update");
});
```

`notionChecks()` from `channelstack/checks` adds the checks every Notion integration should pass: a reply in the same discussion, ignores its own comments, redelivery, a bad signature. See [Standard checks](/docs/guide/standard-checks).

## Delivery specifics

### Signatures and headers

| Header or field | Value |
|---|---|
| `X-Notion-Signature` | `sha256=` and the hex HMAC-SHA256 of the body, keyed with `NOTION_VERIFICATION_TOKEN` |
| `User-Agent` | `notion-api` |
| `attempt_number` (body) | 1 for the first attempt, one more for each retry or redelivery |

Events are sparse, as Notion's are: the entity, its parent, who did it (`authors`), and for content updates the blocks that changed. The agent reads the rest through the API. The integration's own changes come back as events too, with its bot in `authors`, so an agent has to ignore its own comments; `notionChecks()` holds it to that.

### Acknowledgement and retries

The integration has five seconds to answer with a 2xx. A delivery that wasn't answered in time is retried like Notion does, up to eight more times over about a day (after one minute, then 5, 15 and 30 minutes, then 1, 2, 6 and 12 hours). In a test you send it again yourself:

```ts
const comment = await ana.comment("@my-agent hi", { page });

await comment.delivery!.redeliver();                      // the next attempt_number, signed again
await comment.delivery!.resend({ badSignature: true });   // signed with the wrong token
await expect(comment.delivery!).toBeRejected();
```

Notion webhooks carry no timestamp, so there's no `stale` option here. [Delivery and failures](/docs/guide/delivery-and-failures) covers what each of these proves.

### What the fake refuses

Errors have Notion's shape: `{ object: "error", status, code, message, request_id }`.

| Status | Code | When |
|---|---|---|
| 401 | `unauthorized` | No token, or a token that isn't the integration's |
| 400 | `missing_version` | No `Notion-Version` header (one the fake doesn't take is a `validation_error`) |
| 403 | `restricted_resource` | A call that needs a capability the integration doesn't have |
| 404 | `object_not_found` | A page, block, database, comment or user the integration can't see, such as a page it isn't connected to |
| 400 | `validation_error` | A body that doesn't validate: a wrong property type, a bad `page_size`, a malformed rich text |
| 400 | `invalid_json` | A body that isn't JSON |
| 400 | `invalid_request_url` | A path the fake doesn't serve |

The [errors reference](/docs/reference/api/errors) lists every code.

## Live

The same tests can run in a real Notion workspace. Set the integration's token (`CHANNELSTACK_NOTION_TOKEN`), allowlist the workspace with `CHANNELSTACK_LIVE_NOTION_WORKSPACES`, and give each person a personal access token (`CHANNELSTACK_NOTION_USER_ANA_TOKEN` for `createUser({ name: "Ana" })`), which acts as them. Connect the integration by hand, once, to one page (`CHANNELSTACK_NOTION_PAGE`); each session's pages go in a page of their own under it, which goes to the trash when the session closes. Pages the integration must not see go under `CHANNELSTACK_NOTION_UNSEEN_PAGE`.

Live, Notion delivers to your integration itself. Pages, comments, replies, edits, mentions and every read on pages work with the personal tokens. Not live yet: databases and rows (`createDatabase`, `addRow`, `setProperty`, `toHavePropertyValue`), resolving and reopening discussions, and `connect` / `disconnect`, which have no API and need the browser actor, not built for Notion yet. Redelivery, `resend`, `sendVerification` and `setContentUpdateDelay` are fake only. See [Live mode](/docs/guide/live-mode) and the [API reference](/docs/reference/api/notion).
