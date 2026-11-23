# Phase 4 closed

Pull request: [christian-bromann/channelstack#17](https://github.com/christian-bromann/channelstack/pull/17), squash-merged on 2026-11-23 and tagged `phase-4-done`.

## What was built

- **The Linear fake:** GraphQL executed against Linear's committed schema (`schema.graphql` at a pinned commit), with teams, issues, comments, labels, workflow states, delegation, agent sessions and activities, elicitations and prompts, the stop signal, plans and external links. Webhooks are signed with `Linear-Signature`, and each attempt stamps its own `webhookTimestamp` into the body.
- **The Notion fake:** the REST surface `@notionhq/client` uses at `2025-09-03` (users, pages and properties, blocks, databases and data sources with queries, search, comments), connections and their inheritance, Markdown in and out of blocks, and events with `X-Notion-Signature`, `attempt_number`, `page.content_updated` batching and the verification request.
- **Control API and SDKs** for what people do in Linear and Notion, the `linear` and `notion` fixtures and their matchers. The generator gained waits for one of several values, waits that start after a person's prompt, a fixture file as a document, and patterns.
- **`linearChecks()` and `notionChecks()`:** 6 and 4 standard checks. The reference agents pass them, and each fails against the agent with that fault.
- **Reference agents:** `@linear/sdk` and the Chat SDK's Linear adapter; `@notionhq/client`.
- **Every channel in one run:** `api/examples/shared.test.ts` against one server with one agent per channel.

## The gate

`verify:phase (linux-x64)` on the last head, with the acceptance suite 3 of 3, both packaging jobs and the compile of all five targets. Exit checks 4.1 to 4.6 each have a test; phase-log/phase-4/plan.md maps them. Every GraphQL answer and webhook in the Linear unit tests and the acceptance run is held to Linear's schema; Notion's objects and events are typed by the client's own types.

## Review rounds

| Round | Verdict | Findings | Outcome |
|---|---|---|---|
| 1 | changes required | 15 (2 blocking, 7 should-fix, 6 nits) | All fixed |
| 2 | changes required | 7 (4 should-fix, 3 nits) | All fixed |
| 3 | approved | 2 nits | Both fixed |

Every thread is resolved.

## Shared changes worth knowing

- `recordCall` in `core/router/inspect.ts` is the one writer of API-call records for every fake; the transcript entry, its schema and its text live there too.
- The registry lists a session's objects in creation order; Slack's `ts` increases across the world.
- The Vitest fixtures are registered with `test.override`, so `test.extend` can build on them.
- A standard check whose option isn't given is now really left out (it ran before).

## For the maintainer

- An agent's Linear `response`, `elicitation` and `error` are written as comments in the session's thread. Linear doesn't document it; the Chat SDK's adapter relies on it. Unverified until the first live run (reality matrix, decision 0014).
- Notion events for the integration's own changes are sent, with the bot in `authors`. Unverified.
- The Chat SDK's Notion adapter has no base URL option, so it isn't a reference agent until proxy mode (phase 5).
- Contract changes in `api/`: `LinearSessionState` adds `stopping`; `LinearIssue.creator` is a `LinearAuthor`; `waitForActivity` answers the latest prompt; `NotionFixture.setContentUpdateDelay` and `sendVerification`.
