# Phase 13 closed

Pull request: [christian-bromann/channelstack#116](https://github.com/christian-bromann/channelstack/pull/116), squash-merged on 2026-11-28 and tagged `phase-13-done`. Built after phase 12 at the maintainer's instruction ([decision 0029](../../docs/decisions/0029-fake-openai.md)); phase 14 ([#121](https://github.com/christian-bromann/channelstack/pull/121)) is stacked on it.

## What was built

- **A fake OpenAI**, a provider beside the drivers (`server/src/providers/openai/`): no people, apps or deliveries, served at `openai.localhost` on the REST kit, `OPENAI_BASE_URL` and an `sk-proj-` key from `channelstack env`, and `api.openai.com` in proxy mode (13.12).
  - Chat Completions, Responses with stored responses, `previous_response_id`, reasoning and encrypted reasoning, the Conversations API, `GET /v1/models`; OpenRouter's, DeepSeek's and Azure's dialects (13.11). Every answer and stream event held to OpenAI's pinned OpenAPI description (13.2), and the official `openai` SDKs for Node and Python parsing every turn kind and raising every error as their own class, with their retries (13.3).
  - Streams on `core/stream`: `firstToken` counted from the call's arrival, `betweenChunks`, `failAfter` (`error`, `drop`, `stall`), `pauseAfter` and `resume`, on the injected clock; a call the agent abandons is `aborted` (13.7). Rate limits per session with OpenAI's messages and headers (13.8).
- **Scripts and responders:** `openai.respond(turns | responder, { when, times, timing })`, with responders in TypeScript, Python and Rust over a long poll (13.6). An unscripted call is a 400 `channelstack_no_script` and fails the test, at once in a waiting matcher or when the session closes (13.4).
- **Attribution** (`core/attribution`): minted ids, tags, owned ids, text, and order, with retries kept to their first attempt's session; a failing check names the calls no session claimed and the sessions an order tie was between (13.5). The text normalisation it uses is one table, published in the spec and applied by every SDK.
- **Reading and matchers:** `calls()`, `waitForCall()`, `latestCall()`, `toolCalls()`, and `toHaveReceivedCall`, `toHaveSent`, `toHaveSentSecrets` (13.10), `toHaveOfferedTool`, `toHaveSentToolResult`, `toBeAborted`, `toHaveAnswered` in matchers-core, pytest and Rust.
- **The checks:** `model: "openai"` on every channel's checks, with Slack's six model checks and a broken variant for each (13.9, narrowed to Slack with the maintainer's approval; the other channels are #120).
- **Dev tools:** `channelstack openai respond|calls|undo`, MCP's `openai_respond` and `openai_calls`, and the UI's model calls.
- **Reference agents** on the official `openai` SDK (Chat Completions) and the AI SDK (Responses), the examples (13.1), and a LangChain quickstart.
- **The shape lane** (13.13): `pnpm openai:shapes` sends the same requests to the fake and, with `CHANNELSTACK_OPENAI_LIVE_KEY`, to the real API; the fake side runs in the gate.
- **Shared fixes the phase needed:** the server no longer cuts a connection idle for 10s (`Bun.serve`'s `idleTimeout`), which cut held model calls and the control API's long polls; the REST kit records streamed and abandoned answers and keeps a refusal's headers; `check:channels` scans providers; every channel's deliveries name their place.
- **The website:** an OpenAI card with OpenAI's official mark (recorded in `website/public/logos/SOURCES.md`) and a "The model" example in the hero player, in TypeScript, Python and Rust.

## The gate

`pnpm verify:phase 13` passes in CI on the last head, with each acceptance part three times.

## Review rounds

| Round | Verdict | Findings | Outcome |
|---|---|---|---|
| 1 | changes required | 23: 11 blocking, 9 should-fix, 3 nits | All fixed (93e92a8, 34ac7a5, a468fd7, a9cb67a, ce6b980, 98ba5ab); 13.9's narrowing approved by the maintainer |
| 2 | changes required | 8: 2 blocking, 2 should-fix, 4 nits; R1.1, R1.10 and R1.16 reopened | All fixed (208053c) |
| 3 | changes required | 5: 2 should-fix, 3 nits | R3.1 fixed (6b0f77a); R3.2 to R3.4 deferred to #126 |

Every thread is resolved. After three rounds no blocking finding is open, so the phase closes per the maintainer's rule.

## Deferred

- [#120](https://github.com/christian-bromann/channelstack/issues/120): model checks and model-backed reference agents for GitHub, Linear, Notion, email and Discord.
- [#126](https://github.com/christian-bromann/channelstack/issues/126): strict schemas outside OpenAI's subset, `toHaveAnswered` during `firstToken`, an unknown `item_reference`.

## For the maintainer

- The shape lane waits for a repository secret `CHANNELSTACK_OPENAI_LIVE_KEY` (and optionally a variable `CHANNELSTACK_OPENAI_LIVE_MODEL`, default `gpt-5-nano`); until then the nightly job runs the fake side and says it is waiting.
- In a live run, the fake model can attribute a call only by a tag naming the session, since channelstack sees no deliveries there (`docs/live-mode.md` 1.1, open in section 9).
- OpenAI's brand guidelines list using its logo without permission as a don't; `website/public/logos/SOURCES.md` records the gap, as for Slack's and Notion's marks.
