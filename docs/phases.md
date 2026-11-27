# Implementation phases

> 2026-11-20. Replaces the milestone list in implementation-plan.md section 14. Each phase ends with a **gate** (automated checks that one command runs) and a **review** (an independent agent checks the phase and posts its findings on the phase's pull request). A phase is done when the gate is green in CI **and** a review round says *approved*. The next phase doesn't start before that.
>
> Read [AGENTS.md](../AGENTS.md) first for the reading order and conventions.

## Status

| Phase | Status | Closed |
|---|---|---|
| 0 | done | 2026-11-21, [#3](https://github.com/christian-bromann/channelstack/pull/3) |
| 1 | done | 2026-11-21, [#5](https://github.com/christian-bromann/channelstack/pull/5) |
| 2 | done | 2026-11-21, [#12](https://github.com/christian-bromann/channelstack/pull/12) |
| 3 | done | 2026-11-22, [#14](https://github.com/christian-bromann/channelstack/pull/14) |
| 4 | done | 2026-11-23, [#17](https://github.com/christian-bromann/channelstack/pull/17) |
| 5 | done | 2026-11-24, [#18](https://github.com/christian-bromann/channelstack/pull/18) (5.1, 5.2, 5.5 and 5.6 tracked in #19–#22) |
| 6 | done | 2026-11-25, [#23](https://github.com/christian-bromann/channelstack/pull/23) (the nightly half of 6.4 and 6.5 tracked in #31) |
| 7 | done | 2026-11-25, [#32](https://github.com/christian-bromann/channelstack/pull/32) (7.2 dropped, decision 0017; MCP tools for GitHub, Linear and Notion dropped, #33) |
| 8 | done | 2026-11-25, [#57](https://github.com/christian-bromann/channelstack/pull/57) (Resend attachments and raw MIME built since, #64, but for a person's attachments, #84; HTML to text on a library, #65) |
| 9 | done | 2026-11-26, [#66](https://github.com/christian-bromann/channelstack/pull/66) (Gmail verified live against two accounts and a Pub/Sub topic; conformance without a difference) |

## When a phase is done

Each phase is one pull request on [christian-bromann/channelstack](https://github.com/christian-bromann/channelstack). It's done when that PR is merged, which needs all of:

1. `pnpm verify:phase <n>` and every other CI check green on the PR's latest commit (below).
2. The latest review on the PR says **Verdict: approved**, and no review thread is unresolved ([AGENTS.md](../AGENTS.md#how-to-work), skills `implement-phase`, `review-phase`, `address-review`).
3. Every exit-check box in the PR body is ticked.
4. `phase-log/phase-<n>/closed.md` is in the PR and this status table is updated. After the squash merge, `phase-<n>-done` is tagged on `main`.

## How a gate works

Every phase adds its checks to one script:

```bash
pnpm verify:phase <n>     # runs the gates of phase 0..n, in order
```

`verify:phase` runs the **standing checks** below plus the phase's own **exit checks**. CI runs `verify:phase <current>` on every PR, so a later phase can't break an earlier one. It runs it in pieces side by side, each job well under five minutes: `--group static`, `--group unit`, and `--group accept` once per acceptance part (`--part`) and run (`--repeat 1`, three jobs per part). Together they are the whole gate; locally, `pnpm verify:phase <n>` with no group runs all of it.

### Standing checks (every phase, from phase 0 on)

| Check | Command | Passes when |
|---|---|---|
| Types | `pnpm typecheck` | No errors in `server/`, `codegen/`, `integrations/`, `sdks/typescript/`, `sdks/python/`, `scenarios/`, `scripts/` and `api/` (the examples against `api/*.d.ts`, with the Vitest version the contract names) |
| Lint and format | `pnpm lint` | No errors (`bun fmt --check` and lint rules for TypeScript, ruff for Python) |
| Unit tests | `pnpm test` | Green |
| Spec is current | `pnpm spec:check` | Regenerating `spec/openapi.json` and `spec/ir.json` from the routes gives no diff |
| SDKs are current | `pnpm sdk:check` | Regenerating every SDK gives no diff |
| API contract | `pnpm api:check` (from phase 1) | `api/examples/*.test.ts` type-checks against the **generated** TypeScript SDK, not just against `api/*.d.ts`; and every member of every contract handle exists on the generated handle, except the gaps listed with their issues |
| No secrets in output | `pnpm test:redaction` | A test run with known fake and live-shaped tokens finds none of them in logs, errors, recordings or the UI |
| No duplicate code | `pnpm check:dupes` | jscpd finds no copy-pasted block over 15 lines (generated code excluded) |
| Architecture boundaries | `pnpm check:deps` | dependency-cruiser: drivers don't import each other, core doesn't import drivers, nothing imports `generated/` except its SDK |
| No dead code | `pnpm check:unused` | knip finds no unused files, exports or dependencies |
| Flake-free acceptance | `pnpm test:accept --repeat 3` | The acceptance tests pass three runs in a row. In phase 0 these are the smoke scenarios through every SDK; the `api/examples` suites join from phase 1 |
| Docs updated | The phase review | The phase's "Docs to update" list is done, and `docs/code-map.md` matches the code |

### Rules for exit checks

- **Automated.** Every exit check is a test or a script with a pass or fail result. "Looks right" doesn't count.
- **Against real code paths.** Acceptance tests run reference agents built on the platforms' official SDKs (Bolt, Octokit/Probot, `@linear/sdk`, `@notionhq/client`, Chat SDK). They're never run against channelstack's own client code.
- **Deterministic.** Reference agents use a scripted model from their framework (for example the AI SDK's mock provider), never a real LLM in CI.
- **The examples are the spec.** The tests in `api/examples/` become the acceptance suite as phases enable them. A phase lists which `describe` blocks must pass.

## Phase overview

| Phase | Goal | Gate in one line |
|---|---|---|
| 0 | The spine: server, control API, codegen, packaging | The `echo` driver drives the same compiled binary from TypeScript and Python |
| 1 | Slack fake, core conversations | The Slack conversation examples pass against Bolt and Chat SDK reference agents |
| 2 | Slack interactivity and Socket Mode | All fake Slack examples and `slackChecks()` pass |
| 3 | GitHub fake | All fake GitHub examples and `githubChecks()` pass; payloads match GitHub's schemas |
| 4 | Linear and Notion fakes | All fake Linear and Notion examples pass; Linear responses match its GraphQL schema |
| 5 | Live mode | Every "live mode" example passes nightly in the sandboxes, and cleanup leaves nothing behind |
| 6 | Proxy mode and fake-vs-real conformance | An unmodified agent with hard-coded hosts passes; the nightly differential run works |
| 7 | SDK breadth and MCP | Smoke parity in TypeScript, Python and Rust; the pytest integration; MCP drives a conversation |
| 8 | The channel kit, the email core and Resend | Every channel is on the kit; all fake Resend examples and `resendChecks()` pass; Resend passes live |
| 9 | Google (Gmail) | All fake Google examples and `googleChecks()` pass on the kit; Gmail passes live |
| 10 | Twilio (SMS) | All fake Twilio examples and `twilioChecks()` pass on the kit; Twilio passes live |

Phases 1–4 are fake only. Live mode for all channels is phase 5, so the fake design settles before live adapters are written against it.

---

## Phase 0: the spine

**Build:**
- Bun server: Hono + `@hono/zod-openapi`, sessions as scopes, bearer token in `~/.channelstack/server.json` (0600), loopback only, `GET /status`.
- portless: register `channelstack.localhost` and the `<driver>.localhost` aliases on start, remove them on stop; `--no-portless` single-port mode.
- Fake secrets from a CSPRNG once per install in `~/.channelstack/secrets.json` (0600), and `channelstack secrets rotate`.
- The id generator for every platform's formats ([architecture.md](architecture.md), 3.2), seeded by `CHANNELSTACK_SEED`.
- An `echo` driver that goes through the full pipeline.
- Codegen: OpenAPI with `x-channelstack-*` extensions → IR → TypeScript and Python emitters, and the runtime (transport, launcher with `auto`/`attach`/`start`).
- `bun build --compile` for all five targets, `@channelstack/server-<platform>` optional dependencies, CI.
- Every standing check wired into `pnpm verify:phase`, including `check:dupes` (jscpd), `check:deps` (dependency-cruiser rules from `docs/code-map.md`) and `check:unused` (knip).
- **The fake store design:** the `FakeBackend` interface (Hono app over an in-memory store, seeding, reads for transcripts, a hook into the delivery queue), written up in `docs/decisions/0001-fake-backend.md`. Every fake is built by channelstack; no emulate dependency and no copied code.

**Exit checks:**

| # | Check | How |
|---|---|---|
| 0.1 | The control API needs the token | Integration test: `GET /_channelstack/status` gives 200 with the token, 401 without, and the server isn't reachable on a non-loopback address |
| 0.2 | The echo smoke scenario passes in TypeScript and Python | `scenarios/smoke/echo.yaml` through both SDKs, against the **compiled binary** |
| 0.3 | Packaging works | CI job on darwin-arm64 and linux-x64: `npm pack`, install into an empty project, `npx channelstack --version`, then the TS smoke scenario |
| 0.4 | The stale checks catch drift | CI self-test: changing a route without regenerating makes `spec:check` and `sdk:check` fail |
| 0.5 | Ids look real | Unit test: 10,000 generated ids per kind match the format table's patterns and never collide; the same `CHANNELSTACK_SEED` gives the same ids |
| 0.6 | Secrets are stored safely | Unit test: `secrets.json` and `server.json` are created with mode 0600, and `secrets rotate` changes every value |
| 0.7 | The fake store design is locked | `docs/decisions/0001-fake-backend.md` exists, and the `echo` driver's fake implements the `FakeBackend` interface it describes |

**Docs to update:** `architecture.md` if the server layout changed; `docs/decisions/0001-fake-backend.md`.

---

## Phase 1: Slack fake, core conversations

**Build:**
- Slack fake API: `auth.test` (Bolt calls it on every request), `chat.postMessage`, `chat.update`, `chat.delete`, `chat.postEphemeral`, streams (`chat.startStream`, `appendStream`, `stopStream`), `conversations.*`, `users.*`, `reactions.*`, `assistant.threads.*` and `agents.sessions.setStatus`, basic files v2.
- Control API and SDK for: `createUser`, `createChannel({ participants })`, `say`, `reply`, `edit`, `delete`, `react`, `unreact`, `openDM`, `invite`, `kick`, reads (messages, replies, `waitForReply`, `latestReply`, `reactions`, `status`), `uninstallApp`, `fault`.
- Signed HTTP delivery with Slack's retry behaviour, the event log, attribution to sessions.
- Transcripts (edits, deletes, streams, status line, Block Kit text and buttons, ephemeral visibility).
- Quiet detector.
- `channelstack/vitest`: plugin, fixtures, and the Slack matchers.
- `channelstack env`, the attach CLI (`say`, `reply`, `react`, `tail`, `show`), UI v0 (transcript and inspector).
- Reference agents in `examples/agents/`: Bolt + AI SDK (streaming), Chat SDK Slack bot, and `mdac-220`, a deliberately broken agent that leaves a lone "Thinking…" message.

**Exit checks:**

| # | Check | How |
|---|---|---|
| 1.1 | Conversation examples pass | `api/examples/slack.test.ts`: "mentions and threads", "direct messages", "reactions, edits and deletes", "inspecting what the agent did", and the stream and status test, against both reference agents |
| 1.2 | Delivery basics | "delivery and failures": the 3 s retry, bad and stale signatures, rate limit, uninstall |
| 1.3 | The fake signs like Slack | Delivery cases S1 and S6–S8 ([appendix](#appendix-delivery-cases)) as integration tests against the fake's real delivery code, received by Bolt. S2–S5 are interactions (buttons, modals, commands), which phase 2 builds; they are part of exit check 2.2 |
| 1.4 | A real bug is caught | The `mdac-220` agent fails the stream and status test with a message that names the leftover message |
| 1.5 | Negative matchers wait for quiet | Test: a reply posted 500 ms after a `.not.toHaveReplyFrom` check started makes it fail; one posted after `quietFor` doesn't |
| 1.6 | CLI and UI | Scripted: `channelstack slack say --as ana --in "#support" "@my-agent hi"`, then `channelstack show` prints the agent's reply; a browser test opens the UI and finds the same reply in the transcript |
| 1.7 | Parallel sessions are isolated | 20 copies of the DM test run in parallel and every one passes, with no cross-session events |

**Docs to update:** reality-matrix (mark the Slack fake rows done), `devx.md` if any API changed.

---

## Phase 2: Slack interactivity and Socket Mode

**Build:**
- `click`, `select`, `shortcut`, `runCommand`, `stop` (`agent_session_stopped`, `chat.appendStream` returning `stopped_by_user`), `waitForModal` / `submit` / `close` (`views.open`, `views.update`, `view_submission`, `view_closed`), `response_url`.
- The agent split view: `openAgentThread`, `pickPrompt`, `switchContext`, suggested prompts.
- Socket Mode: `apps.connections.open`, WebSocket envelopes, acks with response payloads, `drop_socket` fault.
- `slackChecks()` with the full list in `api/checks.d.ts`.
- Attach CLI: `click`, `stop`.

**Exit checks:**

| # | Check | How |
|---|---|---|
| 2.1 | Every fake Slack example passes | All of `api/examples/slack.test.ts` except "live mode", against both reference agents |
| 2.2 | Socket Mode works with Bolt | The DM and modal tests pass with the Bolt reference agent switched to Socket Mode; delivery cases S2–S5 and K1–K4 ([appendix](#appendix-delivery-cases)) pass against the real fake |
| 2.3 | Standard checks | `slackChecks({ app: "my-agent" })` passes against both reference agents, and against a deliberately broken agent each check fails (one broken variant per check) |

**Docs to update:** reality-matrix, `devx.md` CLI section.

---

## Phase 3: GitHub fake

**Build:**
- Fake REST surface used by Octokit, Probot and the Chat SDK GitHub adapter: repos, contents and the Git Data API, issues, pulls, reviews, review comments, reactions, labels, assignees, check runs and statuses, App and installation endpoints, `/app/hook/deliveries` and redelivery.
- Serve both `github.localhost` as the API root and the `github.localhost/api/v3` alias, for SDKs that assume the GHE layout when a host is set.
- An in-memory git store with real SHAs.
- Webhooks with GUIDs and `X-Hub-Signature-256`; App installation per repo.
- `githubChecks()`.
- Reference agents: Probot and the Chat SDK GitHub adapter.

**Exit checks:**

| # | Check | How |
|---|---|---|
| 3.1 | Every fake GitHub example passes | All of `api/examples/github.test.ts` except "live mode", against both reference agents |
| 3.2 | Responses match GitHub's REST description | Every fake response in the test run validates against `github/rest-api-description` |
| 3.3 | Webhooks match GitHub's schemas | Every delivery validates against `octokit/openapi-webhooks` |
| 3.4 | Standard checks | `githubChecks()` passes, and each check fails against its broken variant |
| 3.5 | The fake signs like GitHub | Delivery cases G1–G3 ([appendix](#appendix-delivery-cases)) pass against the real fake, with `@octokit/webhooks` as receiver |

**Docs to update:** reality-matrix, `architecture.md` if the host layout changed.

---

## Phase 4: Linear and Notion fakes

**Build:**
- **Linear:**
  - GraphQL validated against Linear's introspected schema (fetched and committed).
  - Teams, issues, comments, delegation, agent sessions and activities, elicitation and prompts, the stop signal, plans and external URLs.
  - Signed webhooks with `webhookTimestamp` in the body, and the redelivery re-stamping it.
- **Notion:**
  - The REST surface `@notionhq/client` uses (API version `2025-09-03`): pages, blocks, databases and data sources, comments, users.
  - Connections and their inheritance.
  - Webhooks with the verification handshake, `X-Notion-Signature`, and `page.content_updated` batching with a configurable delay.
- `linearChecks()`, `notionChecks()`.
- Reference agents: a `@linear/sdk` agent and a `@notionhq/client` agent (Chat SDK adapters where they exist).

**Exit checks:**

| # | Check | How |
|---|---|---|
| 4.1 | Every fake Linear example passes | All of `api/examples/linear.test.ts` except "live mode" |
| 4.2 | Every fake Notion example passes | All of `api/examples/notion.test.ts` except "live mode" |
| 4.3 | Linear matches its schema | Every fake GraphQL response validates against the committed introspected schema |
| 4.4 | Signatures | Delivery cases L1–L3 and N1–N3 ([appendix](#appendix-delivery-cases)) pass against the real fake, with `LinearWebhookClient` and `verifyWebhookSignature` as receivers |
| 4.5 | Standard checks | `linearChecks()` and `notionChecks()` pass, and each check fails against its broken variant |
| 4.6 | All channels in one run | `api/examples/shared.test.ts` passes |

**Docs to update:** reality-matrix, close the Notion items in `devx.md` "Still open".

---

## Phase 5: live mode

Spec: [live-mode.md](live-mode.md). Live mode acts and observes, and never relays events to the agent.

**Build:**
- Reality rules (fake or live per object from credentials), the `CHANNELSTACK_LIVE_*` allowlists, tagging, the cleanup ledger, `channelstack sweep`.
- Live adapters per channel: actions as the app and as a person, and the reads behind the transcripts and matchers.
- GitHub delivery-log reads.
- `unsupported_in_live` for fake-only features (delivery chaos on Slack, Linear and Notion, GitHub Re-run, Notion resolve).
- The browser actor, using the session a person saved once with `channelstack login slack`, Slack click and Stop first.
- `channelstack doctor` for live credentials and saved sessions.
- The sandboxes and CI secrets (implementation plan, section 9.5).

**Exit checks:**

| # | Check | How |
|---|---|---|
| 5.1 | Live examples pass | Every "live mode" `describe` block in the four example files passes in the nightly live job against reference agents deployed with their own public URLs |
| 5.2 | Cleanup is complete | After the live job, a sweep check queries each sandbox for objects tagged by that run and finds none |
| 5.3 | Allowlists hold | Test: acting in a workspace, org, team or page outside the allowlist fails with `live_not_allowlisted`, before any call to the platform |
| 5.4 | Fake-only features say so | Test: each "Not yet" or fake-only row in the matrix returns `unsupported_in_live`, and the Vitest integration skips that step with the reason |
| 5.5 | Live spike recorded | V1–V5 from live-mode.md are answered in the matrix's "Still to confirm" list, and the matrix rows are updated |
| 5.6 | Saved browser sessions | `channelstack login slack` saves a person's session (0600), the browser actor reuses it across runs with no manual step, and `channelstack doctor` says whether it is still signed in |

**Docs to update:** reality-matrix (all live cells), live-mode.md, `devx.md` section 10.

---

## Phase 6: proxy mode and conformance

**Build:**
- Proxy mode: host routing to the fakes, channelstack's own name-constrained CA, `channelstack env --proxy`, pass-through recording.
- The recorder, shape differ, the nightly differential run over `scenarios/`, `conformance/divergences.yaml`, the generated coverage page.
- Internal receivers for real webhook payloads (live-mode.md section 6).

**Exit checks:**

| # | Check | How |
|---|---|---|
| 6.1 | No code changes needed | A Node agent with hard-coded `slack.com` passes the phase 1 Slack examples in proxy mode, unmodified |
| 6.2 | Go works through Docker | A Go Slack agent in the Docker image passes the DM test in proxy mode |
| 6.3 | The CA is contained | Test: the CA's name constraints reject a certificate for any host outside the routed list, and the CA is never written to the system trust store |
| 6.4 | Differential run | The nightly job compares fake and live for every scenario; each difference is fixed or recorded in `divergences.yaml` with a reason and an expiry |
| 6.5 | Coverage page | Generated from capabilities, divergences and nightly results, and published by CI |

**Docs to update:** `architecture.md` (proxy), `devx.md` section 9, reality-matrix.

---

## Phase 7: SDK breadth and MCP

**Build:**
- Python: the full SDK and `pytest-channelstack` (fixtures and `expect(...)` checks, [decision 0018](decisions/0018-pytest-expect.md)).
- Rust: the generated SDK.
- `channelstack mcp` and the skill for coding agents.

**Exit checks:**

| # | Check | How |
|---|---|---|
| 7.1 | Smoke parity | All `scenarios/smoke/*.yaml` pass through the TypeScript, Python and Rust SDKs against the same binary |
| 7.2 | ~~Jest~~ | Dropped: no Jest support ([decision 0017](decisions/0017-no-jest.md)). The number stays, so 7.3 and 7.4 keep theirs |
| 7.3 | pytest | A pytest port of the Slack conversation tests passes |
| 7.4 | MCP | A scripted MCP client lists the tools, creates a user, sends a message and reads the agent's reply |

**Docs to update:** `devx.md` sections 4b and 5, architecture.md section 5.

---

## Phase 8: the channel kit, the email core and Resend

[Decision 0021](decisions/0021-email-channels.md): email channels, and why Resend and Gmail. Phases 8 and 9 are two stacked pull requests, at the maintainer's request: phase 9's branches from phase 8's and is retargeted to `main` once phase 8 merges.

**Build:**
- **The channel kit** ([adding-a-channel.md](adding-a-channel.md)): what every driver repeated moves into core, and Slack, GitHub, Linear and Notion move onto it in the same commits, with their own copies deleted. The kit holds:
  - one channel list derived from the driver registry;
  - id, secret and token formats declared by each driver;
  - the delivery kit (`deliveryKit`, `fixedRetries`) and the inspection routes (`registerInspectionRoutes`), written once;
  - a fake's REST API (`restApi`: Notion, echo and Resend through its endpoints, GitHub's own routes through `wrapRest`; Slack's form-posted Web API and Linear's GraphQL endpoint aren't REST), a live platform's refusal (`LivePlatformRefusal`) and waiting out a rate limit (`waitRetryAfter`). Each fake's own setup stays in its driver: seeding is platform-specific, so there is no shared `defineFake`;
  - the fixtures and SDK channel unions, generated;
  - one harness table for the acceptance, live and conformance scripts;
  - schema validators registered per channel.
- `ResendOptions`, `SlackResendOptions` and `LinearResendOptions` become `DeliveryResendOptions`, `SlackDeliveryResendOptions` and `LinearDeliveryResendOptions`, so they don't read as the Resend channel's types.
- **The email core** (`server/src/core/email/`, `api/email.d.ts`): addresses, threading by `Message-ID`, `In-Reply-To` and `References`, email threads as transcripts, and the contract's email bases. Building MIME comes with Gmail's `raw` format in phase 9; Resend's attachments and a received email's raw message are built on it since (#64), but for a person's attachments, which the contract has no option for yet (#84).
- **The Resend fake:**
  - The REST surface the `resend` SDK uses: sending, batches, receiving, attachments and the raw message (#64).
  - `email.received` and the outbound events, signed the Svix way, with Resend's retry schedule.
  - The `@resend.dev` test addresses, idempotency keys, the rate limit and Resend's error shape.
- `resendChecks()`, a reference agent on the `resend` SDK, and its broken variant.
- **Resend live:** the agent's team and each person's own team. Recipients are held to the allowlisted domains, because sent email can't be taken back.

**Exit checks:**

| # | Check | How |
|---|---|---|
| 8.1 | Every channel is on the kit | `pnpm check:channels` passes: each channel has every piece listed in adding-a-channel.md, and no driver bypasses the kit |
| 8.2 | Every fake Resend example passes | All of `api/examples/resend.test.ts` except "live mode" |
| 8.3 | Resend matches its schema | Every fake answer and webhook validates against the pinned `resend-openapi` description |
| 8.4 | Signatures | Delivery cases R1–R3 ([appendix](#appendix-delivery-cases)) pass against the real fake, with the `resend` SDK's `webhooks.verify` as the receiver |
| 8.5 | Standard checks | `resendChecks()` pass, and each check fails against its broken variant |
| 8.6 | All channels in one run | `api/examples/shared.test.ts` passes with Resend |
| 8.7 | Resend live | The "live mode" block of `api/examples/resend.test.ts` passes against the sandbox teams; sending to an address outside the allowlist fails with `live_not_allowlisted` before any call |
| 8.8 | Conformance | `scenarios/resend/` runs in the nightly differential run, and each difference is fixed or recorded in `divergences.yaml` |

**Docs to update:**
- `AGENTS.md` (the channels and addresses rows), `docs/audience.md`, `adding-a-channel.md` (new), `code-map.md`;
- reality-matrix, `live-mode.md` section 4, the `devx.md` tables, `architecture.md`'s id table;
- the environment-variable reference, the Resend platform page, README, `index.html` and the skill.

---

## Phase 9: Google (Gmail)

**Build:**
- **The Google fake on the kit:**
  - The Gmail API surface `googleapis` uses: messages, threads, labels, history, `watch` and `stop`, the profile.
  - Google's token endpoint for the `refresh_token` grant only. Signing users into an app stays out of scope.
  - Pub/Sub push deliveries carrying an RS256 OIDC token from a per-install key, with its JWKS.
  - Gmail's at-most-one-push-a-second rule, and Google's error shape.
- `googleChecks()`, a reference agent on `googleapis` and `google-auth-library`, and its broken variant.
- **Gmail live:** the agent's Gmail account with its Pub/Sub topic, and each person's own account. Recipients are held to the allowlist, and the sweep trashes run-labelled threads.

**Exit checks:**

| # | Check | How |
|---|---|---|
| 9.1 | Every fake Google example passes | All of `api/examples/google.test.ts` except "live mode" |
| 9.2 | Gmail matches its schema | Every fake answer validates against the pinned Gmail discovery document, and every push against Pub/Sub's push format |
| 9.3 | Push tokens | Delivery cases M1–M3 ([appendix](#appendix-delivery-cases)) pass against the real fake, with `google-auth-library`'s `verifyIdToken` as the receiver |
| 9.4 | Standard checks | `googleChecks()` pass, and each check fails against its broken variant |
| 9.5 | All channels in one run | `api/examples/shared.test.ts` passes with Google |
| 9.6 | The kit held | `pnpm check:channels` passes, and the PR lists every file it changed outside the Google driver, its contract, its agents, scenarios and docs |
| 9.7 | Gmail live | The "live mode" block of `api/examples/google.test.ts` passes against the sandbox accounts, the allowlist holds, and the sweep finds nothing left |
| 9.8 | Conformance | `scenarios/google/` runs in the nightly differential run, and each difference is fixed or recorded in `divergences.yaml` |

**Docs to update:** the same list as phase 8, for Google.

---

## Phase 10: Twilio (SMS)

[Decision 0025](decisions/0025-twilio.md): Twilio's Programmable Messaging, SMS first, and why. Phases 10 and 11 (Discord) are built at the same time, each in its own pull request, at the maintainer's request.

**Build:**
- **The Twilio fake on the kit:**
  - The REST API the `twilio` SDK calls for messaging: `messages.create` (from a number or a Messaging Service, with a `StatusCallback`), `list`, `fetch`, `update` (redacting) and `remove`; `accounts.fetch` and `incomingPhoneNumbers.list`. Basic auth with the Account SID and Auth Token or an API key, and Twilio's test credentials with its magic numbers.
  - The inbound webhook: form-encoded, signed with `X-Twilio-Signature`, with `I-Twilio-Idempotency-Token`, Twilio's timeouts and retries and the connection overrides a URL carries. TwiML in the agent's answer is sent, a retry's too.
  - Status callbacks for each change of a message's status (`queued` through a Messaging Service, `sent`, `delivered`, `undelivered`, `failed`), signed the same way.
  - Twilio's error shape and codes, SIDs, E.164, the 1600-character limit and segments, and opt-out (`STOP`, `START`, `HELP`).
- `twilioChecks()`, a reference agent on the `twilio` SDK, and its broken variant.
- **Twilio live:** the agent's account and number, and each person's number on an account of theirs. Recipients are held to the allowlist, and every message a session saw is deleted when it closes.

**Exit checks:**

| # | Check | How |
|---|---|---|
| 10.1 | Every fake Twilio example passes | All of `api/examples/twilio.test.ts` except "live mode" |
| 10.2 | Twilio matches its schema | Every fake answer validates against Twilio's pinned OpenAPI description (`twilio/twilio-oai`), and every webhook's parameters against the Message fields they carry |
| 10.3 | Signatures | Delivery cases T1–T4 ([appendix](#appendix-delivery-cases)) pass against the real fake, with the `twilio` SDK's `validateRequest` and `MessagingResponse` as the receiver |
| 10.4 | Standard checks | `twilioChecks()` pass, and each check fails against its broken variant |
| 10.5 | All channels in one run | `api/examples/shared.test.ts` passes with Twilio |
| 10.6 | The kit held | `pnpm check:channels` passes, and the PR lists every file it changed outside the Twilio driver, its contract, its agents, scenarios and docs |
| 10.7 | Twilio live | The "live mode" block of `api/examples/twilio.test.ts` passes against the sandbox numbers; texting a number outside the allowlist fails with `live_not_allowlisted` before any call, and the sweep finds nothing left |
| 10.8 | Conformance | `scenarios/twilio/` runs in the nightly differential run, and each difference is fixed or recorded in `divergences.yaml` |

**Docs to update:** the same list as phase 8, for Twilio, and decision 0025.

---

## After 0.1

Discord and Stripe drivers, more email providers, third-party driver plugins, LLM-driven personas, transcript export to LangSmith or Braintrust judges. Teams isn't planned. (The full matcher set for pytest, once listed here, is done: [decision 0018](decisions/0018-pytest-expect.md).)

## Appendix: delivery cases

Checks that each fake sends deliveries the platform's **official** receiver accepts. They come from probes run on 2026-11-20 with `@slack/bolt` 5.1.0, `@octokit/webhooks` 14.2.0, `@linear/sdk` 103.0.0, `@notionhq/client` 5.31.1 and Node 24, where all 21 passed. In the phases they're integration tests against the fake's real delivery code (exit checks 1.3, 2.2, 3.5, 4.4).

| Id | The receiver… | Result in the probes |
|---|---|---|
| S1 | Bolt accepts an `event_callback` (JSON) signed with the signing secret | accepted |
| S2 | Bolt routes a `block_actions` (form `payload=`) to the action handler | accepted |
| S3 | For `view_submission`, the agent's `response_action` comes back in the HTTP response body | `{"response_action":"errors",…}` |
| S4 | Bolt accepts a slash command (form fields); the immediate reply is in the HTTP body | accepted |
| S5 | Bolt routes `agent_session_stopped` to the event handler | accepted |
| S6 | A wrong signing secret is rejected | 401 |
| S7 | A timestamp 6 minutes old is rejected | 401 |
| S8 | `X-Slack-Retry-Num` / `X-Slack-Retry-Reason` reach the handler as `context.retryNum` / `retryReason` | 1, `http_timeout` |
| K1 | A Socket Mode agent whose Slack base URL is the fake calls the fake's `apps.connections.open` with its app token and connects to the fake's WebSocket | connected |
| K2 | An `events_api` envelope is handled and acked within 3 s | acked |
| K3 | The ack for `view_submission` carries `response_action` in `payload` | carried |
| K4 | The ack for a slash command carries the immediate reply | carried |
| G1 | A payload re-serialized from parsed JSON doesn't verify with the original `X-Hub-Signature-256` (sign the exact bytes you send) | rejected |
| G2 | Signed with the webhook secret over the sent bytes, `@octokit/webhooks` accepts and dispatches it | accepted |
| G3 | A wrong secret is rejected | rejected |
| L1 | `LinearWebhookClient` accepts a `prompted` webhook with `signal: "stop"` | accepted |
| L2 | A delivery resent after more than 60 s is rejected, because `webhookTimestamp` is inside the signed body | 400 |
| L3 | The same delivery with a new `webhookTimestamp` and a new signature is accepted (so the fake's redelivery re-stamps) | accepted |
| N1 | `verifyWebhookSignature` accepts a body signed with the verification token | accepted |
| N2 | A re-serialized body fails with the original signature | rejected |
| N3 | Re-signed over the sent bytes, it verifies | accepted |
| R1 | The `resend` SDK's `webhooks.verify` accepts an `email.received` signed with the webhook secret over the sent bytes (`svix-id`, `svix-timestamp`, `svix-signature`) | phase 8 |
| R2 | A re-serialized body, or a wrong secret, is rejected | phase 8 |
| R3 | A delivery whose `svix-timestamp` is over five minutes old is rejected, and Resend's retry re-signs with a new timestamp, so it is accepted | phase 8 |
| M1 | `google-auth-library`'s `verifyIdToken` accepts a Pub/Sub push token against the fake's certificates, with the push endpoint as audience | phase 9 |
| M2 | A token for another audience, or signed by another key, is rejected | phase 9 |
| M3 | An expired token is rejected | phase 9 |
| T1 | The `twilio` SDK's `validateRequest` accepts a text's webhook signed with the Auth Token over the URL and the sorted parameters; the URL is the configured one without its fragment of connection overrides | phase 10 |
| T2 | Another token, another URL or a changed parameter fails it, and a forged webhook is refused | phase 10 |
| T3 | As the URL's connection overrides say, a 5xx is retried, with the same `I-Twilio-Idempotency-Token` and a valid signature | phase 10 |
| T4 | TwiML from `MessagingResponse` is sent back to the sender, and its status callbacks validate | phase 10 |

Side finding: Bolt with a single `token` calls `auth.test` on every incoming request, so the Slack fake serves `auth.test` from phase 1.
