# Phase 13 plan

Phase 13 of [docs/phases.md](../../docs/phases.md): a fake OpenAI, scripted per test ([decision 0029](../../docs/decisions/0029-fake-openai.md); design: [interface-draft.md](../model-providers/interface-draft.md), cited as "design §n").

**Started on the maintainer's instruction before phase 12 is merged.** Phase 13 doesn't depend on phase 12's apps. Its branch starts from `docs/fake-openai` (PR #115, which holds the phase's spec), and its PR is stacked on that one.

## Exit checks → work

| Exit check | Test file(s) that prove it | Modules touched or created |
|---|---|---|
| 13.1 The OpenAI examples pass | `test/acceptance/examples/openai.test.ts` against `examples/agents/openai-node` (official `openai` SDK, Chat Completions) and `examples/agents/openai-ai-sdk` (`@ai-sdk/openai`, Responses) | the provider, the SDKs, `integrations/vitest`, `scripts/lib/channels.ts`, `scripts/accept.ts` |
| 13.2 Responses match OpenAI's description | `server/test/schemas/openai.ts` (every answer and stream event in a test run, against the pinned OpenAPI description), `scripts/pinned-schema.ts openai` | `server/test/schemas/`, `scripts/pinned-schema.ts` |
| 13.3 The official SDKs parse it all | `server/src/providers/openai/sdk.test.ts` (the `openai` Node SDK against the fake in process); `test/acceptance/pytest/test_openai_wire.py` (the Python SDK, through pytest-channelstack) | `providers/openai/api.ts`, `codecs/`, `errors.ts` |
| 13.4 A missing script fails the test | `server/src/providers/openai/scripts.test.ts` (the 400 and its message); `integrations/matchers-core/matchers.test.ts` (a waiting matcher fails at once on a model problem); `test/acceptance/stack/openai-no-script.test.ts` (a test that asserts nothing fails when its session closes, Vitest); the pytest and Rust counterparts | `providers/openai/scripts.ts`, `matchers-core`, `integrations/vitest/setup.ts`, pytest plugin, Rust session close |
| 13.5 Attribution | `server/src/core/attribution/attribution.test.ts` (each kind of evidence, order, the message); `test/acceptance/stack/openai-parallel.test.ts` (20 parallel scripted tool loops) | `core/attribution/`, the drivers' authored-text hooks |
| 13.6 Responders in every SDK | `sdks/typescript/runtime/runtime.test.ts`, `sdks/python/tests/test_responder.py`, `sdks/rust/tests/responder.rs` | `x-channelstack-responder`, `codegen`, each SDK's `responder` runtime module |
| 13.7 Timing and breaks | `server/src/core/stream/stream.test.ts`, `server/src/providers/openai/timing.test.ts` (injected clock; the SDK's view of each break) | `core/stream/` |
| 13.8 Rate limits | `server/src/providers/openai/rate-limit.test.ts` | `providers/openai/rate-limit.ts` |
| 13.9 The checks | `test/acceptance/checks/*` with `model: "openai"`, and `checks-broken.test.ts` against `examples/agents/broken-openai` | `integrations/checks/` |
| 13.10 No secrets | `server/src/providers/openai/secrets.test.ts`; `pnpm test:redaction` with the `sk-proj-` prefix | `providers/openai/inspect.ts`, `server/test/prefixed-tokens.ts` |
| 13.11 Conversations, stored responses, dialects | `server/src/providers/openai/sdk.test.ts` ("conversations", "stored responses", "dialects") | `providers/openai/store.ts`, `codecs/` |
| 13.12 Proxy mode | `test/acceptance/proxy-openai.test.ts`: the agent with a hard-coded `api.openai.com` | the provider's `hosts` |
| 13.13 Shapes against the real API | `scripts/live-openai.ts` in the nightly job, against `CHANNELSTACK_OPENAI_LIVE_KEY`. **Waiting for the maintainer's key**, recorded as waiting | `conformance/` |

## Reuse

| Concern | From |
|---|---|
| Mounting at `openai.localhost`, `/openai` and `api.openai.com` | `app.ts` (a driver definition's `hosts`), with a provider being a `DriverDefinition` marked `provider` |
| The REST API: auth, bodies, refusals, call recording | `core/fake/endpoint.ts` (`restApi`) |
| Calls on record, `calls()` reads | `core/router/inspect.ts` (`recordCall`, `readCalls`) |
| Ids | `core/ids/` (`idFormats`, the seeded generator) |
| The key | `core/secrets/` (`SecretSpec`, `secrets.json`) |
| Quiet while a call is in flight | `app.ts`'s `quiet.during` (every request to a fake), and `openWork` for held and stalled calls |
| Session lifetime of scripts | `Sessions.onClose` → the provider's `release` |
| The injected clock and timers | `core/clock/` |
| Durations on the wire | `duration()` (the routes' helper) and the SDKs' `Duration` |
| Waiting and polling in the SDKs | `wait` in each runtime (the responder's long poll builds on the transport, not a new client) |
| Matchers | `integrations/matchers-core/` (Vitest adapts it; pytest and Rust have their counterparts) |
| JSON Schema checks of tool arguments and structured output | `ajv` (already the repository's dev dependency; the server takes it at the same version) |
| Proxy mode | the driver's `hosts` |
| Redaction | `core/redact/` and the definition's `tokenPatterns` |

New:
- `server/src/providers/openai/`: there is no fake of a model; a provider isn't a channel (no people, apps, deliveries or transcripts).
- `server/src/core/stream/`: SSE with timing, breaks and holds is new; no driver streams to the agent over HTTP today.
- `server/src/core/attribution/`: no request today arrives without naming what it is about; every channel's calls name a channel, a repo or a page.
- `responder` in each SDK runtime: no SDK method today takes a function.

## New dependencies

| Package | Version | Why a library and not our code | License | Maintained |
|---|---|---|---|---|
| `openai` (dev) | 7.64.0 | The official SDK: the conformance client and the reference agent. The platforms' official SDKs belong in tests and reference agents (AGENTS.md) | Apache-2.0 | Yes, released weekly |
| `@ai-sdk/openai` (dev) | 4.0.124 | The AI SDK's OpenAI provider, for the second reference agent (Responses), matching `ai` 7.0.177 | Apache-2.0 | Yes |
| `openai` (Python, test only, pytest-channelstack's dev group) | 3.60.0 | The official Python SDK for 13.3 | Apache-2.0 | Yes |
| `ajv` (server runtime) | 8.20.0 | The script's own checks validate the agent's tool arguments and structured output against the JSON Schema it sent; a JSON Schema validator is what AGENTS.md says not to hand-write. The same version the repository's tests already use; pure JavaScript, so it compiles into the binary | MIT | Yes |

## Docs to update

- `AGENTS.md` (the **Models** and **Addresses** rows: already done with decision 0029), README, `index.html` and the skill;
- `devx.md` (sections 1, 2 and 6: already done with decision 0029, except the final API), `architecture.md` (the providers), `implementation-plan.md`, `live-mode.md` (the fake model in a live run);
- reality-matrix (an OpenAI section: every endpoint and turn kind, all fake), `code-map.md` (the provider, `core/stream/`, `core/attribution/`, the `responder` runtime module);
- the website: a page for the fake model, the environment-variable reference, "How it works", "Writing tests", "Standard checks", and the AI SDK and LangChain quickstarts on the fake model.
