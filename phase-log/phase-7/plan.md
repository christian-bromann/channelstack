# Phase 7 plan

SDK breadth and MCP ([phases.md](../../docs/phases.md#phase-7-sdk-breadth-and-mcp), [architecture.md](../../docs/architecture.md) 5, [devx.md](../../docs/devx.md) 4b and 5).

## Exit checks → work

| Exit check | Test file(s) that prove it | Modules touched or created |
|---|---|---|
| 7.1 Smoke parity | `pnpm test:smoke` runs every `scenarios/smoke/*.yaml` through the TypeScript, Python and Rust runners against the same binary | new `codegen/src/emit/rust.ts`, `sdks/rust/` (runtime and generated), `scenarios/runners/rust/`, `scripts/smoke.ts` (`SDKS` gains `rust`) |
| 7.2 Jest | Dropped: no Jest support (the maintainer's decision, [decision 0017](../../docs/decisions/0017-no-jest.md)). `api/jest.d.ts` and its example are removed | — |
| 7.3 pytest | `test/acceptance/pytest/test_slack.py` (a pytest port of the Slack conversation tests) against the Bolt agent | new `integrations/pytest-channelstack/` (fixtures, assertion helpers), on the Python SDK; the Python SDK's handles for every route |
| 7.4 MCP | `server/src/cli/mcp.test.ts`: a scripted MCP client over stdio lists the tools, creates a user, sends a message and reads the agent's reply | new `server/src/cli/mcp.ts` (`channelstack mcp`), `skills/channelstack/SKILL.md` |

## Reuse

| Concern | Module |
|---|---|
| The spec and the IR | `spec/openapi.json`, `spec/ir.json`, `codegen/src/ir.ts`: the Rust emitter reads the same IR as the others |
| What every emitter shares | `codegen/src/emit/shared.ts` |
| The runtime's parts and names | the TypeScript and Python runtimes (transport, launcher, wait, duration, credentials): the Rust runtime has the same modules |
| Attaching or starting a server | each SDK's launcher (`connect({ mode })`) |
| What the MCP tools do | the attach CLI's commands (`cli/slack.ts`, `cli/watch.ts`) over the SDK's client; `show_thread` and `tail` are what `channelstack show` and `tail` print |
| Starting a server with an agent | `scripts/lib/stack.ts` `withStack` |
| New: `sdks/rust/`, `codegen/src/emit/rust.ts` | No Rust SDK exists yet |
| New: `integrations/pytest-channelstack/` | Planned in the code map |
| New: `server/src/cli/mcp.ts` | Planned in the implementation plan (MCP for coding agents) |

## New dependencies

To be pinned as they are added, with the reason.

| Package | Why a library and not our code | License |
|---|---|---|
| `@modelcontextprotocol/sdk` (server) | The protocol's own TypeScript SDK, for the stdio server and the test's client | MIT |
| Rust: `reqwest` (rustls), `tokio`, `serde`, `serde_json`, `thiserror` | HTTP, async, JSON: what every Rust client uses | MIT / Apache-2.0 |
| Rust runner: a YAML parser | The smoke scenarios are YAML | MIT / Apache-2.0 |

## Docs to update

- `docs/devx.md` sections 4b and 5
- `docs/architecture.md` section 5
- `docs/code-map.md` (the Rust SDK, pytest-channelstack, MCP)
