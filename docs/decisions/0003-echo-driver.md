# 0003: The echo driver ships, as an experimental surface

Status: accepted, phase 0.

## Context

Phase 0 requires an `echo` driver that goes through the full pipeline, and a smoke scenario that drives it from two SDKs against the compiled binary (exit check 0.2). Phase 7 runs every smoke scenario through three SDKs. So the echo driver must be in the released binary and in the generated SDKs. But the public API (`api/*.d.ts`) names four channels, and `ChannelKind` has no `echo`.

## Decision

- **Echo is a real driver, in the binary and in every generated SDK.** It is a platform of channelstack's own: people, rooms, messages, an app with a token and a signing secret, a provider API, and signed deliveries. It follows the driver layout in `docs/code-map.md` file for file.
- **It is marked experimental and internal.** Every echo route carries `x-channelstack-stability: experimental`. Echo is not exported from the public types, isn't a `ChannelKind`, gets no test-framework fixture, and isn't documented for users.
- **The generated client is reachable only through `channelstack/client`** (TypeScript) and `channelstack.generated` (Python), which the test integrations are built on. `channelstack/client` is itself experimental until the integrations ship in phase 1; the public contract stays `api/*.d.ts`.
- **Its ids and secrets are our own formats** (`EU…`, `ER…`, `echo_app_…`), since no real platform defines them. They follow the same rules as the others: ids from the seeded generator, secrets from the CSPRNG.

## Why

- **It keeps the protocol honest across languages.** A driver with no platform quirks is the cheapest way to prove that sessions, handles, cursors, errors, delivery and launchers behave the same in every SDK.
- **It is the reference for the driver contract.** Decision 0001 is locked against it, and each new driver has a small, complete example to follow.
- **Shipping it costs little.** It adds a few kilobytes and no dependency, and hiding it behind a build flag would mean the tested binary is not the released one.

## Alternatives considered

- **Build echo only into a test binary.** Rejected: exit check 0.2 and 7.1 test the compiled binary that ships; a second build would not be that binary.
- **Add `echo` to `ChannelKind` and the public fixtures.** Rejected: it would put a toy platform in front of users and in the contract.
- **Use Slack as the first driver instead.** Rejected by docs/phases.md: phase 0 proves the spine before any platform's complexity arrives.
