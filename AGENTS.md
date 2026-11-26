# AGENTS.md

Instructions for coding agents implementing channelstack. Read this first.

## What channelstack is

A test harness for AI agents that live in Slack, GitHub, Linear, Notion and email (Resend and Gmail). One server fakes those platforms in memory. Tests script people (`ana.say("@my-agent hi", { channel })`) and assert on what a person would see (`expect(thread).toHaveReplyFrom("my-agent")`). The same API can also act on the real platforms (live mode).

## Reading order

| # | Document | What it is | Status |
|---|---|---|---|
| 1 | [docs/phases.md](docs/phases.md) | What to build, in which order, and the gate that proves each phase is done | **Spec** |
| 2 | [docs/architecture.md](docs/architecture.md) | How the server and the SDK generator work, id formats | **Spec** |
| 3 | [api/](api/) (`*.d.ts` and `examples/`) | The public TypeScript API, and examples that become the acceptance tests | **Spec** (the contract) |
| 4 | [docs/devx.md](docs/devx.md) | How developers use it: CLI, environment, tests, UI | **Spec** |
| 5 | [docs/live-mode.md](docs/live-mode.md) | Live mode: acting on real platforms and observing results | **Spec** |
| 6 | [docs/reality-matrix.md](docs/reality-matrix.md) | Per method: works in fake, works live, and what live needs | **Spec** (reference) |
| 7 | [docs/implementation-plan.md](docs/implementation-plan.md) | The long-form design: protocol, drivers, conformance, security, SDK generation | **Spec** (detail) |
| — | [docs/niche.md](docs/niche.md), [docs/audience.md](docs/audience.md), [docs/app-developers.md](docs/app-developers.md), [docs/framework-testing.md](docs/framework-testing.md), [docs/competitive-analysis.html](docs/competitive-analysis.html) | Why we build it, for whom, and the market | Background only |
| 8 | [docs/code-map.md](docs/code-map.md) | Which module owns each concern. Check it before writing any function | **Spec** (kept current) |
| — | [phase-log/](phase-log/) | Each phase's plan and closing note (reviews live on the PRs) | Working record |
| — | [index.html](index.html) | The landing page | Marketing; must match the API |

**When documents disagree,** the order of precedence is:
1. `api/*.d.ts`
2. `docs/phases.md`
3. `docs/architecture.md`
4. `docs/live-mode.md`
5. `docs/devx.md`
6. `docs/reality-matrix.md`
7. `docs/implementation-plan.md`

Fix the lower-ranked document in the same PR, and say so in the PR description.

## How to work

### Repository

- **GitHub:** [christian-bromann/channelstack](https://github.com/christian-bromann/channelstack) (private). Default branch `main`. Use the `gh` CLI for everything on GitHub.
- **Bootstrap, once:** the repository starts empty. Before phase 0, the first agent turns this folder into the repository: `git init -b main`, add `LICENSE` (MIT), a `.gitignore` (`node_modules/`, build output, `.env*`), commit the existing docs, API types, probes and skills as `docs: initial design`, add the remote and push. That initial commit is the only direct push to `main`.
- **After that, everything goes through pull requests.** No direct pushes to `main`, no force-pushes to `main`, no `--admin` merges.

### One pull request per phase

Every phase is one PR, and runs the same loop, with a skill for each step (in `.claude/skills/`; plain Markdown, so any agent can follow them):

```
implement-phase ─► draft PR ─► gate green, PR ready ─► review-phase (fresh context, posts on the PR)
      ▲                                                        │
      │                                          Verdict: approved? ── yes ──► closed.md ─► merge ─► tag phase-<n>-done
      │                                                        │ no
      └────────────── address-review (replies, fixes, resolves threads) ◄┘
```

1. **[implement-phase](.claude/skills/implement-phase/SKILL.md):** branch `phase-<n>-<slug>` from `main`, tag `phase-<n>-start`, write `phase-log/phase-<n>/plan.md` (each exit check → its test → the modules it touches, what's reused from the code map, new dependencies) and open a **draft PR** with a checklist of every exit check. Build, push often, and mark the PR ready when `pnpm verify:phase <n>` is green in CI.
2. **[review-phase](.claude/skills/review-phase/SKILL.md):** a **different** agent, in a fresh context, reviews the whole phase against the spec, the code map and these rules, and posts **one GitHub review per round**: an inline comment per finding (numbered, with severity: blocking, should-fix, nit) and a summary whose first line is the verdict.
3. **[address-review](.claude/skills/address-review/SKILL.md):** the implementer handles every finding: fixes it (new commit, reply with the sha and the test that proves it, resolve the thread), defers it (non-blocking only, with an issue, then resolves), or declines it (reply with evidence; the reviewer decides). Then the next review round starts in a fresh context.
4. **Merge** when the latest review says *Verdict: approved*, no review thread is unresolved, every box in the PR body is ticked and every CI check passes: add `phase-log/phase-<n>/closed.md`, update the status table in `docs/phases.md`, squash-merge, tag `phase-<n>-done` on `main`.

**Same account, so no GitHub approvals.** The implementer and reviewer agents post from the same GitHub account, and GitHub doesn't let an account approve or request changes on its own PR. Reviews are therefore posted as comments, and the verdict line in the review summary is what counts.

**Stop and ask the maintainer** (comment **needs maintainer** on the PR and don't merge) when a blocking finding survives three rounds, the implementer wants to decline a blocking finding, or a merge condition can't be met.

### Rules

- **One phase at a time.** Don't start phase *n+1* until phase *n*'s PR is merged and tagged. Set up `verify:phase` and CI in phase 0.
- **The examples are the acceptance tests.** `api/examples/*.test.ts` must pass against reference agents as each phase enables them. Don't weaken an example to make it pass. If an example is wrong, fix it and the types together, and say why.
- **Keep `api/*.d.ts` and the generated TypeScript SDK in sync.** `pnpm api:check` type-checks the examples against the generated SDK, and checks that every member of every contract type exists on what implements it (gaps listed with their issues). If the generated SDK can't satisfy `api/*.d.ts`, change the generator or the routes, or change the contract on purpose with a note in the PR.
- **Update the docs a phase lists** under "Docs to update", in the same PR.
- **Record decisions** in `docs/decisions/<id>.md`: what was decided, why, and the alternatives.

### No duplicate implementations

Agents tend to write the same function twice when they can't see the first one. Three things prevent that:

1. **[docs/code-map.md](docs/code-map.md)** names the one module that owns each concern (ids, signing, delivery, waiting, errors, redaction, …). Search it, then search the code, **before writing any function**. Use or extend what exists. A new module goes into the code map in the same commit.
2. **Automated checks** in every phase gate: `pnpm check:dupes` (copy-paste detection), `pnpm check:deps` (architecture boundaries: drivers don't import each other, core doesn't import drivers), `pnpm check:unused` (dead code and unused exports).
3. **The review** treats a second implementation of a concern as a blocking finding, and the fix is to delete one and move every caller to the other.

### Dependencies

Use a dependency wherever a good one exists; don't hand-write what a maintained library already does well (HTTP and routing, validation, WebSockets, JSON Schema and GraphQL validation, git objects, the browser actor, test frameworks, the platforms' official SDKs in reference agents and tests).

- **What stays ours:** the fake platforms themselves, the transcripts and the matchers. They're the product, so they aren't layered on another emulator (the closed MDA stack showed why).
- **A dependency must be:** permissively licensed (MIT, Apache-2.0, BSD, ISC), maintained (a release in the last 12 months or clearly stable), widely used, compatible with Bun and the compiled binary (avoid native modules), and pinned to an exact version. The published Python and Rust libraries are the exception: their manifests take a range up to the next major version, and their lock files pin what CI tests ([decision 0023](docs/decisions/0023-releases.md)).
- **Record each new runtime dependency** in the phase plan with the reason; the review checks it.

## Decisions that are settled

Don't reopen these without asking.

| Area | Decision |
|---|---|
| Channels | Slack, GitHub, Linear, Notion, and email: Resend and Google (Gmail), [decision 0021](docs/decisions/0021-email-channels.md). No Teams for now |
| Addresses | portless names: `https://channelstack.localhost` (UI and control API at `/_channelstack`), `slack.localhost`, `github.localhost`, `linear.localhost`, `notion.localhost`, `resend.localhost`, `google.localhost` |
| World | One shared fake workspace, org or integration per channel per server. Sessions are scopes inside it, not separate worlds |
| State | In memory. A restart starts fresh |
| The agent | channelstack never starts or wraps it. `channelstack env` prints what it needs |
| Default mode | Base-URL mode through portless. Proxy mode is opt-in |
| Test API | Actor-first: `ana.say(text, { channel })`. Resources are only read and waited on. Users are created per test (`createUser`); there is no config file (each fake has a built-in app named `my-agent`, and `CHANNELSTACK_<CHANNEL>_WEBHOOK_URL` says where its events go); the app joins conversations explicitly (`participants: [ana, slack.app]`) |
| Ids | Every handle uses the platform's own id format, in fake mode too (architecture.md 3.2) |
| Tests | Integrate into Vitest and pytest with fixtures and matchers. No separate test package, no own runner. No Jest ([decision 0017](docs/decisions/0017-no-jest.md)) |
| Models | channelstack doesn't mock LLMs. Agents use their framework's own fake model |
| Live mode | Acts on real platforms and reads results back. **Never relays, forwards or synthesizes events to the agent.** Delivery chaos is fake only |
| Secrets | Fake tokens and signing secrets come from a CSPRNG once per install, stored in `~/.channelstack/secrets.json` (0600). No hard-coded secrets anywhere. Live credentials stay in memory, are never logged and never returned by the control API |
| UI | Functional (transcripts, inspector, chaos controls), not a pixel copy of each product |
| Independence | channelstack implements the fake platforms itself; they aren't layered on emulate or another emulator, and no emulator code is copied. Ordinary libraries are welcome (see "Dependencies") |
| Server | Bun, Hono, `@hono/zod-openapi`, single binary via `bun build --compile` |
| SDKs | Own generator: routes → OpenAPI with `x-channelstack-*` extensions → IR → per-language emitters |

## Still open

These are for the maintainer. Don't decide them alone; ask, or flag them in the PR.

| # | Question | Default if unanswered |
|---|---|---|
| D5 | License | MIT |

## Conventions

- **TypeScript strict** everywhere; ESM.
- **Package manager:** pnpm workspaces; the server builds with Bun.
- **No secrets in output.** Redact tokens, signing secrets, emails and user names in logs, errors, recordings and the UI. `pnpm test:redaction` enforces it.
- **Platform realism.** Fakes refuse what the real platform refuses, with the same error codes, and only send what the real platform sends.
- **Commits:** small and focused, each naming the exit check it moves. Phase PRs are squash-merged, with the PR title as the commit title (`Phase <n>: <goal>`).
- **Branches:** `phase-<n>-<slug>` for phases; `fix/<slug>` for fixes between phases, which go through the same review loop.
