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
| 11 | done | 2026-11-27, [#103](https://github.com/christian-bromann/channelstack/pull/103) (built in parallel with phase 10; Discord verified live with the agent's bot and two people's bots; conformance without a difference) |

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
| Types | `pnpm typecheck` | No errors in `server/`, `codegen/`, `integrations/`, `sdks/typescript/`, `sdks/python/`, `scenarios/`, `scripts/` and `test/` (the examples in `test/acceptance/examples/` against the generated TypeScript SDK) |
| Lint and format | `pnpm lint` | No errors (`bun fmt --check` and lint rules for TypeScript, ruff for Python) |
| Unit tests | `pnpm test` | Green |
| Spec is current | `pnpm spec:check` | Regenerating `spec/openapi.json` and `spec/ir.json` from the routes gives no diff |
| SDKs are current | `pnpm sdk:check` | Regenerating every SDK gives no diff |
| No secrets in output | `pnpm test:redaction` | A test run with known fake and live-shaped tokens finds none of them in logs, errors, recordings or the UI |
| No duplicate code | `pnpm check:dupes` | jscpd finds no copy-pasted block over 15 lines (generated code excluded) |
| Architecture boundaries | `pnpm check:deps` | dependency-cruiser: drivers don't import each other, core doesn't import drivers, nothing imports `generated/` except its SDK |
| No dead code | `pnpm check:unused` | knip finds no unused files, exports or dependencies |
| Flake-free acceptance | `pnpm test:accept --repeat 3` | The acceptance tests pass three runs in a row. In phase 0 these are the smoke scenarios through every SDK; the `test/acceptance/examples` suites join from phase 1 |
| Docs updated | The phase review | The phase's "Docs to update" list is done, and `docs/code-map.md` matches the code |

### Rules for exit checks

- **Automated.** Every exit check is a test or a script with a pass or fail result. "Looks right" doesn't count.
- **Against real code paths.** Acceptance tests run reference agents built on the platforms' official SDKs (Bolt, Octokit/Probot, `@linear/sdk`, `@notionhq/client`, Chat SDK). They're never run against channelstack's own client code.
- **Deterministic.** Reference agents use a scripted model from their framework (for example the AI SDK's mock provider), never a real LLM in CI.
- **The examples are the spec.** The tests in `test/acceptance/examples/` become the acceptance suite as phases enable them. A phase lists which `describe` blocks must pass.

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
| 11 | Discord: a bot in a guild, on the Gateway and HTTP interactions | All fake Discord examples and `discordChecks()` pass against discord.js; Discord passes live |
| 12 | Any number of agent apps per channel | Every channel's "several apps" examples pass against two agents; the reply loop is caught on every channel; no existing test changed |

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
| 1.1 | Conversation examples pass | `test/acceptance/examples/slack.test.ts`: "mentions and threads", "direct messages", "reactions, edits and deletes", "inspecting what the agent did", and the stream and status test, against both reference agents |
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
- `slackChecks()` with the full list in `integrations/checks/`.
- Attach CLI: `click`, `stop`.

**Exit checks:**

| # | Check | How |
|---|---|---|
| 2.1 | Every fake Slack example passes | All of `test/acceptance/examples/slack.test.ts` except "live mode", against both reference agents |
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
| 3.1 | Every fake GitHub example passes | All of `test/acceptance/examples/github.test.ts` except "live mode", against both reference agents |
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
| 4.1 | Every fake Linear example passes | All of `test/acceptance/examples/linear.test.ts` except "live mode" |
| 4.2 | Every fake Notion example passes | All of `test/acceptance/examples/notion.test.ts` except "live mode" |
| 4.3 | Linear matches its schema | Every fake GraphQL response validates against the committed introspected schema |
| 4.4 | Signatures | Delivery cases L1–L3 and N1–N3 ([appendix](#appendix-delivery-cases)) pass against the real fake, with `LinearWebhookClient` and `verifyWebhookSignature` as receivers |
| 4.5 | Standard checks | `linearChecks()` and `notionChecks()` pass, and each check fails against its broken variant |
| 4.6 | All channels in one run | `test/acceptance/examples/shared.test.ts` passes |

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
- **The email core** (`server/src/core/email/`): addresses, threading by `Message-ID`, `In-Reply-To` and `References`, email threads as transcripts, and the contract's email bases. Building MIME comes with Gmail's `raw` format in phase 9; Resend's attachments and a received email's raw message are built on it since (#64), but for a person's attachments, which the contract has no option for yet (#84).
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
| 8.2 | Every fake Resend example passes | All of `test/acceptance/examples/resend.test.ts` except "live mode" |
| 8.3 | Resend matches its schema | Every fake answer and webhook validates against the pinned `resend-openapi` description |
| 8.4 | Signatures | Delivery cases R1–R3 ([appendix](#appendix-delivery-cases)) pass against the real fake, with the `resend` SDK's `webhooks.verify` as the receiver |
| 8.5 | Standard checks | `resendChecks()` pass, and each check fails against its broken variant |
| 8.6 | All channels in one run | `test/acceptance/examples/shared.test.ts` passes with Resend |
| 8.7 | Resend live | The "live mode" block of `test/acceptance/examples/resend.test.ts` passes against the sandbox teams; sending to an address outside the allowlist fails with `live_not_allowlisted` before any call |
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
| 9.1 | Every fake Google example passes | All of `test/acceptance/examples/google.test.ts` except "live mode" |
| 9.2 | Gmail matches its schema | Every fake answer validates against the pinned Gmail discovery document, and every push against Pub/Sub's push format |
| 9.3 | Push tokens | Delivery cases M1–M3 ([appendix](#appendix-delivery-cases)) pass against the real fake, with `google-auth-library`'s `verifyIdToken` as the receiver |
| 9.4 | Standard checks | `googleChecks()` pass, and each check fails against its broken variant |
| 9.5 | All channels in one run | `test/acceptance/examples/shared.test.ts` passes with Google |
| 9.6 | The kit held | `pnpm check:channels` passes, and the PR lists every file it changed outside the Google driver, its contract, its agents, scenarios and docs |
| 9.7 | Gmail live | The "live mode" block of `test/acceptance/examples/google.test.ts` passes against the sandbox accounts, the allowlist holds, and the sweep finds nothing left |
| 9.8 | Conformance | `scenarios/google/` runs in the nightly differential run, and each difference is fixed or recorded in `divergences.yaml` |

**Docs to update:** the same list as phase 8, for Google.

---

## Phase 11: Discord

[Decision 0026](decisions/0026-discord.md): Discord as channel 8, and why the Gateway, HTTP interactions, and a second bot as a person live. Phase 10 (Twilio) is built at the same time, in its own pull request, at the maintainer's request.

**Build:**
- **The Discord fake on the kit:**
  - The Gateway (v10, JSON): `GET /gateway/bot`, HELLO, IDENTIFY with the bot's token and intents, heartbeats, READY and GUILD_CREATE, dispatches with sequence numbers (`MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`, `MESSAGE_REACTION_ADD`, `MESSAGE_REACTION_REMOVE`, `CHANNEL_CREATE`, `CHANNEL_UPDATE`, `THREAD_CREATE`, `INTERACTION_CREATE`), RESUME and INVALID_SESSION, Discord's close codes. Intents enforced, `MESSAGE_CONTENT` among them. Waiting for the agent's connection moves into core (`core/socket`), and Slack's Socket Mode uses it.
  - REST v10, the routes discord.js calls: messages, replies, edits, deletes, reactions, typing, threads, DMs, the guild, application commands, the interaction callback and followups.
  - Interactions over HTTP, signed with Ed25519, with the PING/PONG check and the 3-second deadline; over the Gateway without an interactions endpoint.
  - Discord's realism: snowflake ids, its error shape and JSON codes, permissions from roles and overwrites, per-route rate limits with `X-RateLimit-*` and 429 `retry_after`, the 2000-character limit.
- `discordChecks()`, a reference agent on discord.js, and its broken variant.
- **Discord live:** the agent's bot in a sandbox guild (`CHANNELSTACK_LIVE_DISCORD_GUILDS`), each session's channels made, tagged and deleted by it; a person as a second application's bot in the guild, acting through REST v10 with its token (`CHANNELSTACK_DISCORD_USER_<NAME>_TOKEN`), its `author.bot` recorded as a difference; the sweep.

**Exit checks:**

| # | Check | How |
|---|---|---|
| 11.1 | Every fake Discord example passes | All of `test/acceptance/examples/discord.test.ts` except "live mode", against the discord.js reference agent |
| 11.2 | Discord matches its description | Every fake answer, and every Gateway dispatch whose object it describes, validates against the pinned `discord/discord-api-spec` (`pnpm discord:schema --check`) |
| 11.3 | The Gateway and interactions | Delivery cases D1–D8 ([appendix](#appendix-delivery-cases)) pass against the real fake, with discord.js and `discord-interactions`'s `verifyKey` as receivers |
| 11.4 | Standard checks | `discordChecks()` pass, and each check fails against its broken variant |
| 11.5 | All channels in one run | `test/acceptance/examples/shared.test.ts` passes with Discord |
| 11.6 | The kit held | `pnpm check:channels` passes, and the PR lists every file it changed outside the Discord driver, its contract, its agents, scenarios and docs |
| 11.7 | Discord live | The "live mode" block of `test/acceptance/examples/discord.test.ts` passes against the sandbox guild, the allowlist holds, and the sweep finds nothing left |
| 11.8 | Conformance | `scenarios/discord/` runs in the nightly differential run, and each difference is fixed or recorded in `divergences.yaml` |

**Docs to update:** the same list as phase 8, for Discord, and decision 0026.

---

## Phase 12: any number of agent apps per channel

[Decision 0027](decisions/0027-multiple-apps.md): a channel holds any number of people and apps, each app a real agent app with its own identity, and `my-agent` stays. Phase 12 starts once phases 10 (Twilio) and 11 (Discord) are merged, and covers all eight channels. Its open questions are answered by the maintainer before it starts, or it takes their defaults.

**Build:**
- **Apps by name, on every channel and echo:** `createApp({ name, … })` and `apps()` on each fixture; apps in the shared world, ids derived from `CHANNELSTACK_SEED` and the name, secrets per app in `secrets.json`, `CHANNELSTACK_<CHANNEL>_APP_<NAME>_WEBHOOK_URL`, `channelstack env --app` and `channelstack.env({ app })`.
- **Each fake answers and delivers per app:** each token answers as its app; each delivery goes to one app, signed with its secret, at its URL or connection (Socket Mode, the Gateway), with `deliveries({ app })` and `msg.deliveryFor(app)`; faults and Slack's `uninstallApp` take an app.
- **What one app's actions send the others,** per channel, as the decision's tables say, including what the platforms refuse between bots (`cannot_dm_bot`, Discord's 50007, interactions and agent sessions of one app only).
- **Scripted apps:** an extra app's handle has the acting methods a person has on its channel, through the fake's API with the app's token; refused for `my-agent`.
- **The reply loop:** `toGoQuiet` in matchers-core, the pytest `expect` and the Rust crate; the loop guard and its `bot_loop` event; `<channel>.no-reply-loop` in every `<channel>Checks()`, and a variant of each broken agent that answers every app.
- **Matchers and transcripts:** authors resolved among all of a channel's apps and people; the UI shows each app and its deliveries.
- **The examples:** a `describe("several apps")` block in each `test/acceptance/examples/<channel>.test.ts`, run against two instances of the channel's reference agent, as `my-agent` and as a second app, both in `scripts/lib/channels.ts`.
- **Live:** per-app credentials (`CHANNELSTACK_<CHANNEL>_APP_<NAME>_*`), checked when the app is made; the second sandbox apps of the channels the maintainer chooses, their agents deployed with public URLs, and their Request URLs on the nightly run's internal receivers for B1–B10.

**Exit checks:**

| # | Check | How |
|---|---|---|
| 12.1 | Nothing that exists changed | Every example, check suite and smoke scenario passes as before, and a script compares each `test(...)` and scenario that existed at `phase-12-start` with HEAD by name and finds its body unchanged (imports aside): no existing test was edited to pass |
| 12.2 | Every channel's "several apps" examples pass | The `describe("several apps")` blocks of all eight example files, except "live mode", against two instances of each reference agent |
| 12.3 | The platforms' bot-to-bot rules | Integration tests per channel, one per row of the decision's "what it hears from another app" and "what another app can't do": the event is sent with the platform's fields (`bot_id`, `app_id`, `sender.type: "Bot"`, `authors[].type: "bot"`, `author.bot`), or the action is refused with the platform's code, and every webhook validates against the channel's schema. A row marked "to confirm" is held to what the decision says the fake does until it is answered |
| 12.4 | Each app is signed for alone | Delivery cases A1–A3 ([appendix](#appendix-delivery-cases)) pass against the real fake, with each channel's official receiver |
| 12.5 | Credentials per app | Unit tests: an app's secrets are made once, kept in `secrets.json` (0600), the same after a restart and new after `secrets rotate`; the same seed and name give the same ids in any order of creation; `channelstack env --app coder` prints the app's variables under `my-agent`'s keys; `pnpm test:redaction` runs with two apps per channel |
| 12.6 | The loop is caught | Against each channel's broken variant, `<channel>.no-reply-loop` fails with a message naming the authors in turn, and `toGoQuiet` fails the same way; against the reference agent both pass. Two looping agents trip the guard, which stops the deliveries, records `bot_loop` and fails the test |
| 12.7 | Checks run against any app | `<channel>Checks({ app: "coder" })` passes for every channel against the reference agent driving `coder` |
| 12.8 | Every SDK | `scenarios/smoke/apps.yaml` (two echo apps, a scripted app's message, `toGoQuiet`) passes through the TypeScript, Python and Rust SDKs against the binary |
| 12.9 | The kit holds | `pnpm check:channels` requires each channel's apps routes, per-app env, delivery cases A1–A3, "several apps" examples and `no-reply-loop`, and passes |
| 12.10 | Parallel sessions stay apart | 20 copies of a two-app Slack test and a two-App GitHub test run in parallel and pass, with no delivery from one session's conversation in another's |
| 12.11 | Live | The "live mode" part of the "several apps" blocks passes nightly on the channels with second sandbox apps; their B items are answered in the reality matrix's "Still to confirm" list and the fake follows the answers, and the other channels' B items are listed there as still open |
| 12.12 | Names and limits | Tests: an eleventh app on a channel, a name outside the format, `my-agent`, and a taken name with other settings are refused with `invalid_argument`; the same name and settings return the same app; acting as `my-agent` is refused; a name that is both a person's and an app's in one session is refused in a matcher, and another session's apps never change what a name means |
| 12.13 | Live apps are checked | Tests against each live world's identity check, before any action: an app whose variables are missing is `live_misconfigured` naming them; a person's token, `my-agent`'s, or another app's is refused; an app outside the allowlist is `live_not_allowlisted`; a live app's handle carries empty tokens, and `env --app` prints nothing for a live channel |

**Docs to update:**
- `AGENTS.md` (the "Test API" row: already done with decision 0027), README, `index.html` and the skill;
- `devx.md` section 3 and the `channelstack env` section, `architecture.md` (the world holds apps; the id table's app ids per app), `implementation-plan.md` (the no-config-file lines), `live-mode.md` (per-app credentials and the spike), decision 0013 (one installation per App);
- reality-matrix (a "several apps" row per channel, the loop guard as fake only, B1–B10), `code-map.md` (`core/loops/`), `adding-a-channel.md` (apps in the checklist);
- the website: the environment-variable reference, "How it works", "Writing tests", "Standard checks", each platform page, and a guide to testing agents together.

---

## After 0.1

Stripe drivers, more email providers, third-party driver plugins, LLM-driven personas, transcript export to LangSmith or Braintrust judges. Teams isn't planned. (The full matcher set for pytest, once listed here, is done: [decision 0018](decisions/0018-pytest-expect.md).)

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
| D1 | discord.js, with the fake as its REST API, finds the Gateway at `/gateway/bot`, identifies with its token and intents, and becomes ready with the guild | phase 11 |
| D2 | A person's message reaches discord.js as `messageCreate`, with its content under `MESSAGE_CONTENT` (without the intent it is empty unless it mentions the bot: a unit test) | phase 11 |
| D3 | A dropped connection is resumed: discord.js sends RESUME with its session and sequence, and gets what was dispatched while it was away, once | phase 11 |
| D4 | A bad token is closed with 4004; a privileged intent the app doesn't have with 4014 | phase 11 |
| D5 | `discord-interactions`'s `verifyKey` accepts an interaction signed with the install's key over the sent bytes, against the app's public key | phase 11 |
| D6 | A re-serialized body, or one signed with another key, is rejected | phase 11 |
| D7 | Without an interactions endpoint, a slash command reaches discord.js as `interactionCreate`; its `reply` within 3 s is the response, and one after 3 s is refused with 10062 | phase 11 |
| D8 | Discord's endpoint check: a PING is answered with a PONG, and a PING with a bad signature is refused with 401 | phase 11 |
| A1 | On every channel, an event two apps hear is two deliveries, each with its own id, sent to its own app's URL or connection, and signed for that app where the platform signs: with its own secret on Slack, Linear, Notion and Resend; on GitHub with its own secret, `installation.id` and `X-GitHub-Hook-Installation-Target-ID`; on Google with its own push audience. Each app's official receiver (Bolt, `@octokit/webhooks`, `LinearWebhookClient`, `verifyWebhookSignature`, the `resend` SDK's `webhooks.verify`, `verifyIdToken`) accepts its own and rejects the other's. Twilio: two numbers of one account share its Auth Token, as Twilio signs, so `validateRequest` tells them apart by the URL, which is in the signature: each number's delivery fails against the other's URL. Discord: Gateway dispatches aren't signed, so each app's connection gets its own; an interaction goes to the one app it belongs to, signed with that app's key, and `verifyKey` rejects it against another app's public key | phase 12 |
| A2 | Bolt with `ignoreSelf` drops the app's own message, and hands another app's (`bot_id`, `app_id`, `bot_profile`, no subtype) to the message handler; Probot receives an `issue_comment` by `other[bot]` with `sender.type: "Bot"` | phase 12 |
| A3 | Two apps connected at once, over Socket Mode (Bolt) and the Gateway (discord.js), each get only their own envelopes and dispatches, and an ack or a reply on one connection is never taken as the other's | phase 12 |

Side finding: Bolt with a single `token` calls `auth.test` on every incoming request, so the Slack fake serves `auth.test` from phase 1.
