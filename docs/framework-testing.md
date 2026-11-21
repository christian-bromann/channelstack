# How agent frameworks test channel integrations

Research date: 2026-11-19. Method: shallow clones of each repo, reading the test code, plus each project's GitHub issues. Read-only.

## Summary per framework

| Framework | Approach | Simulated user, assert on reply? | Deterministic LLM | Streaming / retries | Teams |
|---|---|---|---|---|---|
| **OpenClaw** (openclaw/openclaw) | Four levels: SDK mocks (~1.1k Slack tests); `qa-channel` synthetic bus; **Crabline**, local provider-shaped servers (full flows for Discord only); nightly **live** lanes on real Slack, Discord, Telegram, WhatsApp and Matrix with leased credentials | ✅ about 630 YAML scenarios in QA Lab, one transport adapter for synthetic, Crabline or live | `mock-openai` server parses "reply exactly MARKER" directives | Streaming drafts yes; write retries explicitly not exercised | Mocks only. A fix is blocked "needing tenant-backed proof" (#199876) |
| **Hermes Agent** (NousResearch/hermes-agent) | aiohttp **stand-in servers** for Slack (incl. Socket Mode and streams), Telegram and Discord; real SDKs redirected through a `sitecustomize` shim | ✅ shared `_contract.py` scenarios with a small driver per platform, run against the real gateway subprocess | Loopback fake LLM server that speaks the OpenAI wire format | ✅ `streamed_reply_shown_once`, `redelivered_inbound_gets_one_reply`; uses barrier messages instead of sleeps | 3 tests |
| **Vercel Chat SDK** (vercel/chat) | emulate 0.6 (Slack, GitHub) in-process, with its own Slack re-signer; SHA-tagged replays of production recordings; `vi.fn` mocks | ✅ `postAsHuman` → `waitForDelivery` → read the emulator's store | n/a | Streaming only through replay | Replay and mocks only |
| **Flue** (withastro/flue) | Hand-signed inbound requests through `hono.request()`; Teams JWT and JWKS fakes. Outbound never tested; channel tests since removed from the public mirror | ❌ | Pi's `fauxProvider` | ❌ | Inbound JWT only |
| **Pi** (earendil-works/pi, pi-chat) | Effectively none. `pi-mom` (Slack) had one test that never touched Slack and was deleted; `pi-chat` has no tests | ❌ | `fauxProvider` (not used for channels) | ❌ | ❌ |
| **ElizaOS** | Real runtime with a capture-object Slack client ("does not exercise Socket Mode or Slack itself"); fake Telegram Bot API; live Discord suite | Partial | Model fixtures | Telegram edit-in-place | ❌ |
| **Mastra** | `vi.fn` adapters, a stubbed `fetch`, the AI SDK's `MockLanguageModelV2` | ❌ | ✅ | ❌ | Mocks |
| **Microsoft** (Bot Framework, M365 Agents SDK) | In-memory `TestAdapter` / `TestFlow`: `.send('hi').assertReply(...)`; `microsoft-agents-testing` for Python; Agents Playground (manual) | ✅ but skips the channel wire format entirely | — | ❌ | The same in-memory adapter |
| **Slack Bolt** | Internal mock Web API server and `FakeReceiver`, neither exported. bolt-python#380 asking for a test kit has been open since 2021 | ❌ for users | — | — | — |
| **LangChain** (deepagents talon, design-agent) | Hand-written `Fake*` Discord objects; `fake_slack.py` built on `httpx.MockTransport` | Partial | `EchoAgent` stub | design-agent stores streams | ❌ |

## Findings

1. **Two serious frameworks built channelstack on their own.** OpenClaw (QA Lab, qa-channel, Crabline, mock-openai) and Hermes (stand-ins, `_contract.py`, the fake LLM server) independently arrived at the same design:
   - provider-shaped fake servers that the real SDK talks to
   - one scenario suite with a driver per platform
   - a fake LLM that speaks the wire format
   - optionally, the same scenarios run against live workspaces

   Neither is packaged for anyone else. This is the strongest demand signal found so far: the teams that care most build it, and everyone else mocks.
2. **Hermes's scenario names are channelstack's assertion list:** `dm_gets_exactly_one_reply`, `streamed_reply_shown_once`, `rejected_finalize_leaves_one_copy`, `redelivered_inbound_gets_one_reply`, `approval_click_by_allowlisted_user_runs_command`.
3. **The common approach is still SDK mocks** (Mastra, ElizaOS, Flue, teams.ts, most of Chat SDK). Their bugs reach production: Pi had replies posted outside the thread and files uploaded to the wrong channel, and Flue had silent no-replies (#380).
4. **Teams is the clearest gap.** No framework has a Teams/Bot Framework wire-level fake. emulate's Microsoft service is OAuth only. OpenClaw has a fix blocked for lack of a tenant. Microsoft's own `TestFlow` skips the wire format.
5. **Streaming and redelivery** are covered only by Hermes. emulate has no stream routes. OpenClaw rejects retries in its Slack e2e mode.
6. **Running the same scenarios against fakes and real workspaces** is how OpenClaw keeps its fakes honest: it runs nightly with a credential pool. That is the conformance-suite idea, already proven in practice.
7. **Being language-neutral is a requirement, not a bonus.** Hermes is Python, OpenClaw and Chat SDK are TypeScript, and Bolt ships in both. Fakes have to be servers reached over the network, not in-process mocks.

## What this means for channelstack

- **Package what OpenClaw and Hermes built:**
  - provider-shaped servers, on emulate where it fits, plus overlays for streams, Socket Mode and Teams
  - a portable scenario suite in YAML, or code with a driver per platform
  - a fake LLM that speaks the OpenAI/Anthropic wire format
  - a live lane that runs the same scenarios
- **Ship a contract suite of standard agent-channel scenarios** (exactly one reply, streamed once, redelivery handled idempotently, Stop honoured, approval-click authorization) that any agent can run. That's more adoptable than an API alone.
- **Lead with Teams and Slack streaming**, the two areas nobody covers.
- **Borrow the good techniques:**
  - barrier messages instead of sleeps (Hermes)
  - marker directives for the fake model (OpenClaw)
  - xfail only on a matching failure signature (Hermes)
  - fail if any call reaches the real provider host (OpenClaw Crabline)
  - the `send().assertReply()` ergonomics (Microsoft TestFlow)
- **Go-to-market:** pitch to OpenClaw and Hermes maintainers as "drop your in-house harness". Their reaction is the adoption test.
- **Risk:** OpenClaw extracts and packages Crabline and QA Lab itself. It has the scale (~395k stars) to define the category.
