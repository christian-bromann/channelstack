# Phase 12 plan: any number of agent apps per channel

[Decision 0027](../../docs/decisions/0027-multiple-apps.md). A channel holds any number of apps,
each a real app of its platform with its own identity, credentials and endpoint; `my-agent`
stays the default. The open questions of the decision take their defaults (no answer yet).

**Started before phases 10 and 11 merged**, on the maintainer's instruction (2026-11-27): the
spec (#105) was merged and phase 12 is built for the six channels on `main` (Slack, GitHub,
Linear, Notion, Resend, Google) and echo. Twilio (#102) and Discord (#103) get their apps in a
follow-up once they land; that is recorded in `closed.md` with its issue. Discord landed while
phase 12 was open, was merged into this branch, and got its apps here; Twilio's stay in #113.

## Exit checks → work

| Exit check | Test file(s) that prove it | Modules touched or created |
|---|---|---|
| 12.1 Nothing that exists changed | `scripts/check-unchanged-tests.ts` (in `verify:phase 12`, static) against `phase-12-start` | new script |
| 12.2 "Several apps" examples | `describe("several apps")` in each `test/acceptance/examples/<channel>.test.ts`, against two instances of each reference agent | `scripts/lib/channels.ts` (`HARNESS`: a second agent as `coder`), `scripts/lib/stack.ts` |
| 12.3 Bot-to-bot rules | `server/src/drivers/<channel>/<channel>-apps.test.ts` per channel | each driver's `fake/` (store: apps by name; delivery per app; token → app) and `payloads.ts` |
| 12.4 Delivery cases A1–A3 | `server/test/integration/apps-delivery.test.ts` | `core/delivery/kit.ts` (the secret per app) |
| 12.5 Credentials per app | `core/secrets/secrets.test.ts`, `core/ids/ids.test.ts`, `core/apps/apps.test.ts`, `app.test.ts` (`/env?app=`), `pnpm test:redaction` | `core/secrets` (per-app secrets), `core/ids` (`named`), new `core/apps`, `app.ts`, `cli.ts` |
| 12.6 The loop is caught | `test/acceptance/checks-broken.test.ts` (`no-reply-loop` against the broken variants), `integrations/matchers-core` tests (`toGoQuiet`), `core/loops/loops.test.ts` | new `core/loops`, `integrations/matchers-core`, `integrations/vitest`, `integrations/pytest-channelstack`, `sdks/rust/src/expect`, `integrations/checks`, `examples/agents/broken-*` |
| 12.7 Checks run against any app | `test/acceptance/checks/<channel>-checks.test.ts` with `app: "coder"` | `integrations/checks/index.ts` |
| 12.8 Every SDK | `scenarios/smoke/apps.yaml` through the TS, Python and Rust runners | echo driver, `scenarios/runners/*` |
| 12.9 The kit holds | `pnpm check:channels` | `scripts/check-channels.ts` |
| 12.10 Parallel sessions stay apart | `test/acceptance/isolation.test.ts` (two apps, 20 copies) | — |
| 12.11 Live | nightly `live.yml`, for the channels with second sandbox apps | each driver's `live/` (identity check per app) |
| 12.12 Names and limits | `core/apps/apps.test.ts`, `server/src/app.test.ts` | `core/apps` |
| 12.13 Live apps are checked | each driver's `live/live.test.ts` against its stub | each driver's `live/identity.ts` |

## Reuse

| Concern | From |
|---|---|
| Secrets per app | `core/secrets` (`Secrets`): extended with `forApp`, kept beside the driver's own under `apps.<name>` |
| Ids per app, independent of creation order | `core/ids` (`IdGenerator`): extended with `named(key)`, a draw seeded by the seed and the key that shares the uniqueness sets |
| Signing a delivery for its app | `core/delivery/kit.ts`: `secret(app)` and `Outgoing.app` |
| Inspection: deliveries by app | `core/router/inspection.ts` (a filter beside `type` and `resource`) |
| Name rules, webhook URLs per app | new `core/apps`: nothing owns app names today |
| The loop guard | new `core/loops`: one counter for every driver (decision 0027) |
| Waiting for quiet | `core/quiet` and the matchers' existing quiet wait, for `toGoQuiet` |
| Mentions | `core/rich-text` (`richTextPieces`): an app's name resolves like the built-in app's |

## New dependencies

None.

## Docs to update

- `AGENTS.md` (the "Test API" row: already done with decision 0027), README, `index.html` and the skill;
- `devx.md` section 3 and the `channelstack env` section, `architecture.md` (the world holds apps; the id table's app ids per app), `implementation-plan.md` (the no-config-file lines), `live-mode.md` (per-app credentials and the spike), decision 0013 (one installation per App);
- reality-matrix (a "several apps" row per channel, the loop guard as fake only, B1–B10), `code-map.md` (`core/apps/`, `core/loops/`), `adding-a-channel.md` (apps in the checklist);
- the website: the environment-variable reference, "How it works", "Writing tests", "Standard checks", each platform page, and a guide to testing agents together.
