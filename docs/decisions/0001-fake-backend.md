# 0001: The fake backend and its store

Status: accepted, phase 0. Locked by exit check 0.7 (`server/src/drivers/echo/fake-backend.test.ts`).

## Decision

Every fake platform is a `FakeBackend`: a Hono app that emulates the provider API, over an in-memory store. All four channel drivers use this one design. The `echo` driver is its first implementation.

```ts
// server/src/core/router/driver.ts
interface FakeBackend {
  /** The provider API emulation, served at the driver's host (`<name>.localhost`) or path prefix (`/<name>`). */
  readonly api: Hono;
  /** Seed the world-level objects that exist before any session: the workspace and the agent's app. Also re-seeds after a reset. */
  seed(): void;
  /** Remove what a closed session owned from the store's own indexes. The registry drops the objects themselves. */
  release(session: string): void;
}
```

A driver builds its fake from a `DriverContext`, which is everything core hands it:

| The fake needs | It gets it from | Why not its own |
|---|---|---|
| Ids in the platform's format | `context.ids` (`core/ids`) | One seeded source, so ids never collide across drivers and a seed reproduces a run |
| Time | `context.clock` | Timestamps in ids, payloads and signatures stay testable |
| Objects and who owns them | `context.registry` (`core/registry`) | Ownership is what makes a session a scope; a driver with private maps would have to re-implement it |
| The event log | `context.events` (`core/events`) | One log per session across all channels, with one cursor format |
| Sending events to the agent | `context.delivery` (`core/delivery`) | The delivery hook: the only code that calls the agent, so retries, timeouts and faults exist once |
| Its tokens and signing secrets | `context.secret(name)` (`core/secrets`) | Secrets come from the CSPRNG and `secrets.json` only |

### The four parts

1. **Provider API (`fake/api.ts`).** A plain Hono app with the platform's own routes, authentication and error codes. It refuses what the platform refuses. Core mounts it at `<driver>.localhost` and at `/<driver>` and never looks inside. It is not part of the control API, so it isn't in the OpenAPI document or the SDKs.
2. **Store (`fake/store.ts`).** Objects live in typed collections from the core registry, each with its owning session (or none, for world-level objects such as the app). The store adds only the indexes the platform's reads need (messages per room; later, replies per thread, comments per issue). Lists that tests poll are `CursorList`s from `core/events`.
3. **Seeding (`seed()`).** Creates what exists before any session: one workspace, org or integration and the agent's app. `POST /reset` clears the registry and calls `seed()` again.
4. **Reads for transcripts.** The driver's `World` exposes the reads (`messages(...)`), and `transcript.ts` renders them into what a person would see. Fake and live produce transcripts with the same renderer.

### Where each action lives

Every control action is written once, as a method of the driver's `World` (`world.ts`). The fake implements that interface in `fake/world.ts`: write to the store, build the payload with `payloads.ts`, hand it to `context.delivery` with the platform's signer from `core/signing`, and append to the event log. A live backend (phase 5) implements the same interface against the real platform. Control routes (`routes.ts`) only validate and call the `World`.

Sessions clean up in two steps: core calls `fake.release(session)` so the store can drop its own indexes, then drops the session's objects from the registry and its event log.

## What phase 0 builds, and what comes later

| Part of the driver contract in architecture.md 3.3 | Phase 0 | Later |
|---|---|---|
| `routes`, `fake`, `capabilities()` | Built | — |
| Transcript renderer | `transcript.ts`, called by the driver's transcript route | Shared with live reads in phase 5 |
| `inbound` (sign and deliver) | `payloads.ts` builds, `core/signing` signs, `core/delivery` sends | Platform retry rules and Socket Mode in phases 1–2 |
| `live` backend, `hosts` for the proxy | Not built | Phases 5 and 6 |

The `Driver` interface in the code has only what exists. Members are added in the phase that first uses them, so no interface is ahead of its implementation.

## Why

- **Independence.** The fakes are channelstack's own; they aren't layered on another emulator and no emulator code is copied (AGENTS.md, "Independence"). A small contract of our own is what makes that practical for four platforms.
- **One store design.** The closed MDA stack had a different fake per platform, each with its own ownership and logging. A shared registry and event log remove that duplication and make session isolation a property of core, not of each driver.
- **The provider API stays opaque to core.** Slack's form-encoded Web API, GitHub's REST and Linear's GraphQL have nothing in common. A Hono app per driver lets each be exactly what its platform is.

## Alternatives considered

- **Wrap an existing emulator** (`@emulators/*`). Rejected in implementation-plan.md 8.2: missing surfaces (streams, Stop), no control over fidelity, and a license tie.
- **A generic store with a query language** shared by all drivers. Rejected: the platforms' read models differ too much, and the registry already covers what is common (identity and ownership).
- **A database (SQLite) behind the fakes.** Rejected: state is in memory by decision, a restart starts fresh, and the binary stays free of native modules.
