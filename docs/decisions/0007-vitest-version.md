# 0007: The Vitest integration targets Vitest 5

Status: accepted, phase 1. Decided by the maintainer.

## Context

`api/vitest.d.ts` was written against Vitest 3.2: it adds the fixtures by augmenting `TestContext` in `@vitest/runner`. Current Vitest is 5.1, where that augmentation no longer reaches the test context.

## Decision

- `channelstack/vitest` supports **Vitest 5** (`>=5.0.0 <6`), declared as a peer dependency.
- `api/vitest.d.ts` is changed on purpose to the augmentation Vitest 5 reads, and `api/` is type-checked against Vitest 5. The Vitest 3.2 development dependencies in `api/` are removed.
- The Jest contract (`api/jest.d.ts`, Jest 30) is unchanged; Jest support is phase 7.

## Why

One version to build and test against. Supporting 3.2 as well would double the test matrix for a version two majors behind.

## Alternatives considered

- **Vitest 3.2 through 5.** Rejected by the maintainer: more work and a wider matrix.
- **Vitest 3.2 only.** Rejected: new projects install Vitest 5.
