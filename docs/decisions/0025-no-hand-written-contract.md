# 0025: No hand-written contract beside the generated SDKs

Status: accepted, 2026-11-26, by the maintainer.

## What was decided

- **`api/*.d.ts` is gone.** Until the first release the public TypeScript API was designed by hand
  in `api/*.d.ts`, and `pnpm api:check` held the generated SDK to it: the examples type-checked
  against the SDK, and every member of every contract handle had to exist on the generated handle
  (`codegen/src/contract.ts`, with its `KNOWN_GAPS`). With 0.1 the generated SDKs are published, so
  they are the API. The contract, `api:check`, `contract.ts` and the `@channelstack/api-contract`
  workspace package are removed.
- **The examples stay, as the acceptance tests.** They move from `api/examples/` to
  `test/acceptance/examples/` and type-check against the generated TypeScript SDK and its Vitest
  integration in `pnpm typecheck` (the root `tsconfig.json` maps `channelstack`, `channelstack/vitest`
  and `channelstack/checks` to their sources). The acceptance run plays them against the reference
  agents, as before.
- **The website's samples** (`website/samples/`, `website/examples/ts/`) type-check against the same
  sources (`website/tsconfig.samples.json`), not the contract.
- **The order of precedence** in AGENTS.md loses its first entry. The routes describe the API
  (`spec/openapi.json`), and the SDKs follow from them.

## Why

- The contract was there to design the API before there was an implementation, and to keep the
  generated SDK close to that design. Now every change to the API was written twice, kept in step by
  a check with its own list of gaps, and the published types were the generated ones anyway.
- Checking the examples against the generated SDK keeps what mattered: what a test calls has to
  exist and have the right types. Doing it for every example, not only the enabled tests of two
  channels, found two lines that only ever type-checked against the contract:
  `linear.calls({ operation: /.*/, error: true })` (the SDK filters operations by name, so the
  pattern was sent as a string and matched nothing; the example now asks for every call that
  failed) and a `@ts-expect-error` that `ana.say("hi")` needs a `channel` (the SDK takes `channel`
  or `to`, and checks at run time).

## Alternatives

- **Keep the contract for design review.** A change to the API would still be reviewed in one
  readable file. But the generated API reference on the website, and the diff of
  `sdks/typescript/generated/` in the pull request, show the same change, and they can't drift.
- **Generate `.d.ts` files into `api/`.** It would only copy what `sdks/typescript` already
  publishes.
