# Phase 7 plan

SDK breadth and MCP ([phases.md](../../docs/phases.md#phase-7-sdk-breadth-and-mcp), [architecture.md](../../docs/architecture.md) 5, [devx.md](../../docs/devx.md) 4b and 5).

## Exit checks → work

| Exit check | Test file(s) that prove it | Modules touched or created |
|---|---|---|
| 7.1 Smoke parity | `pnpm test:smoke` runs every `scenarios/smoke/*.yaml` through the TypeScript, Python and Rust runners against the same binary | new `codegen/src/emit/rust.ts`, `sdks/rust/` (runtime and generated), `scenarios/runners/rust/`, `scripts/smoke.ts` (`SDKS` gains `rust`) |
| 7.2 Jest | Dropped: no Jest support (the maintainer's decision, [decision 0017](../../docs/decisions/0017-no-jest.md)). `api/jest.d.ts` and its example are removed | — |
| 7.3 pytest | `test/acceptance/pytest/test_slack.py` (a pytest port of the Slack conversation tests) against the Bolt agent | new `integrations/pytest-channelstack/` (fixtures, assertion helpers), on the Python SDK; the Python SDK's handles for every route |
| 7.4 MCP | `test/acceptance/mcp.test.ts` (with the Bolt agent, like 1.6's CLI test): a scripted MCP client over stdio lists the tools, posts as a person it creates, reads the agent's reply, tails, lists and redelivers | new `server/src/cli/mcp.ts` (`channelstack mcp`) and `server/src/cli/deliveries.ts` (`channelstack deliveries`, `redeliver`), `readEvents` in `cli/watch.ts`, `skills/channelstack/SKILL.md`. `github_comment`, `linear_delegate` and `notion_comment` deferred to #33 |

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

Each pinned to an exact version. The Rust toolchain is pinned in `rust-toolchain.toml` (1.99.0, with rustfmt and clippy).

| Package | Why a library and not our code | License |
|---|---|---|
| `@modelcontextprotocol/sdk` 1.32.2 (server, and the root for the test's client) | The protocol's own TypeScript SDK, for the stdio server and the test's client | MIT |
| Rust SDK: `reqwest` =0.13.5 (`json`, `query`, `rustls`), `tokio` =1.54.1, `serde_json` =1.0.154, `thiserror` =2.0.21, `percent-encoding` =2.3.2 | HTTP with TLS (portless serves HTTPS), async, JSON, typed errors and path escaping: what Rust clients use | MIT / Apache-2.0 |
| Rust smoke runner: `yaml-rust2` =0.13.0, `regex` =1.13.1 | The smoke scenarios are YAML, and their `matches` checks regular expressions | MIT / Apache-2.0 |
| Rust SDK, after review: `regex` =1.13.1 (already in the workspace), `tempfile` =3.27.0 | Patterns are regular expressions with flags, as in the other SDKs; the launcher's private directory is created 0700 under a name nobody can guess, like `mkdtemp` | MIT / Apache-2.0 |
| CI: `Swatinem/rust-cache` v2.9.3 (by commit) | Caches the Rust builds between runs | MIT |
| pytest-channelstack: `pytest` ==8.4.2, `pytest-asyncio` ==1.4.1 | The framework it plugs into, and async tests and fixtures on one event loop (1.5.0 is under two weeks old) | MIT / Apache-2.0 |

## Docs to update

- `docs/devx.md` sections 4b and 5
- `docs/architecture.md` section 5
- `docs/code-map.md` (the Rust SDK, pytest-channelstack, MCP)
