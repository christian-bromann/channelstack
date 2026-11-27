---
name: implement-phase
description: Implement one channelstack phase from docs/phases.md end to end in its own pull request — plan it against the code map, build it without duplicating existing logic, get its gate green, request an independent review on GitHub, and merge once approved. Use when starting or continuing work on a phase.
---

# Implement a phase

You implement exactly one phase from `docs/phases.md`, in one pull request on `christian-bromann/channelstack`. A phase is finished only when its PR is merged: gate green, an independent review approved on the PR, every review thread resolved. Never start the next phase before that.

## 1. Prepare

1. Read `AGENTS.md`, the phase's section in `docs/phases.md`, `docs/code-map.md`, and every document the phase section links.
2. Check that the previous phase is merged: its PR is merged and the tag `phase-<n-1>-done` exists (`git fetch --tags`). If not, finish that phase first.
3. Branch from the latest `main`:
   ```bash
   git switch main && git pull
   git switch -c phase-<n>-<short-slug>
   git tag phase-<n>-start && git push origin phase-<n>-start
   ```

## 2. Plan, then open a draft PR

Write `phase-log/phase-<n>/plan.md`:

```markdown
# Phase <n> plan

## Exit checks → work
| Exit check | Test file(s) that prove it | Modules touched or created |
|---|---|---|

## Reuse
For each concern this phase needs: the existing module from docs/code-map.md that provides it,
or "new: <path>" with one sentence on why nothing existing fits.

## New dependencies
| Package | Version | Why a library and not our code | License | Maintained |

## Docs to update
(copied from the phase section)
```

Commit it, push, and open a **draft** PR:

```bash
gh pr create --draft --base main --title "<type>(<scope>): phase <n>, <goal from docs/phases.md>" --body-file <body>
```

The title is a Conventional Commit from the types and scopes in CONTRIBUTING.md ("The title"), since the squash merge's commit title is what the changelog is drafted from, and the `PR title` check refuses any other: `feat(slack): phase 10, Slack canvases`. Several scopes are separated by commas: `feat(slack,github): …`.

PR body:

```markdown
Phase <n> of docs/phases.md: <goal>. Plan: phase-log/phase-<n>/plan.md

## Exit checks
- [ ] <n>.1 <check name>
- [ ] <n>.2 …
(one box per exit check, ticked when its test passes in CI)

## Standing checks
- [ ] `pnpm verify:phase <n>` green in CI
- [ ] Acceptance tests green 3 runs in a row

## Docs updated
- [ ] … (from the phase's "Docs to update")
- [ ] docs/code-map.md matches the code

## New dependencies
(from the plan, or "none")
```

## 3. Build

- **Before writing any function, search first.** Look in `docs/code-map.md`, then search the code for the concern (`grep -rn` the verb and the noun, e.g. `sign`, `signature`, `hmac`). If it exists, use it. If it nearly fits, extend it there. Never write a second version next to the first.
- **New shared logic goes where the code map says it goes,** and the code map gets the new row in the same commit.
- **Follow the driver contract** (`docs/architecture.md` 3.3): each action is written once against `World`; payloads come from `payloads.ts`; drivers never import each other.
- **Dependencies:** follow the policy in `AGENTS.md`, and add each new one to the plan's table and the PR body.
- **Tests first for exit checks.** Turn each exit check into its test before building the feature, and make sure it fails for the right reason.
- **Don't weaken acceptance tests** (`test/acceptance/examples/*.test.ts`, exit-check tests) to make them pass. If one is wrong, fix it and its spec together and say why in the PR.
- **Small commits, pushed often,** each naming the exit check it moves. Tick the PR's boxes as checks go green in CI.

## 4. Gate

`pnpm verify:phase <n>` green in CI on the PR, and the acceptance tests green three runs in a row (`pnpm test:accept --repeat 3`). Then mark the PR ready:

```bash
gh pr ready
```

## 5. Review

Start the `review-phase` skill **in a fresh context** (a separate agent or session that hasn't seen your work), with the PR number. Don't review your own phase. When the review is posted, follow `address-review`. Repeat until a review round says **approved**.

## 6. Close and merge

All of these must be true. Check each one; don't assume:

| Condition | How to check |
|---|---|
| The latest review summary says **Verdict: approved** | `gh pr view <pr> --comments` / the PR's reviews |
| No unresolved review threads | The GraphQL query in `address-review`, step 4, returns 0 |
| Every box in the PR body is ticked | `gh pr view <pr>` |
| All CI checks pass on the latest commit | `gh pr checks <pr>` |

Then:

1. Add `phase-log/phase-<n>/closed.md`: what was built, the PR link, the CI run that passed the gate, the review rounds and their outcomes, anything deferred with its issue link. Update the status table at the top of `docs/phases.md`. Commit, push, and wait for CI to pass again.
2. Merge and tag:
   ```bash
   gh pr merge <pr> --squash --delete-branch
   git switch main && git pull
   git tag phase-<n>-done && git push origin phase-<n>-done
   ```

Never merge with failing or pending checks, never use `--admin`, never force-push `main`.
