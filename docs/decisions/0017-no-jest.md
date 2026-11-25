# 0017: No Jest

Status: accepted, phase 7. The maintainer's decision.

channelstack integrates with Vitest and pytest, not with Jest. The `channelstack/jest` preset that `api/jest.d.ts` described, its usage example and exit check 7.2 are dropped.

## Why

Few new TypeScript projects choose Jest, and channelstack's users are the ones writing agents now. A second TypeScript integration would be one more surface to keep in step with the contract for little use.

## What changes

- **Removed:** `api/jest.d.ts`, `api/examples/jest.usage.test.ts`, `api/tsconfig.jest.json` and `@types/jest`.
- **Exit check 7.2** is marked dropped in docs/phases.md. Its number stays, so 7.3 and 7.4 keep theirs.
- **Docs:** AGENTS.md's settled decisions, devx 5, the architecture, the implementation plan, the code map, the README and the landing page name Vitest and pytest only.
- **Not affected:** the matchers stay framework-neutral (`integrations/matchers-core`), so another TypeScript runner could adapt them later without changing them.

## Alternatives considered

- **Keep the preset, without the port of the Slack tests.** Rejected: it would still be a contract to keep, and a framework to keep in CI.
