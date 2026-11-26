---
name: review-phase
description: Independently review a channelstack phase pull request against its spec, the code map and the project rules, and post the review on GitHub with one inline comment per finding and a verdict. Run in a fresh context that didn't implement the phase, once the PR is ready for review.
---

# Review a phase PR

You are the reviewer, not the implementer. Work only from the repository and the PR: the specs, the code, the PR's history. Don't trust claims in commit messages, the plan or replies to earlier reviews — check them.

Input: the PR number `<pr>` on `christian-bromann/channelstack`. The phase number `<n>` is in its title (`feat(<scope>): phase <n>, <goal>`).

## 1. Read

```bash
gh pr view <pr>                       # description, checklist
gh pr view <pr> --comments            # earlier review summaries and replies
gh pr checkout <pr>
git diff phase-<n>-start...HEAD       # the whole phase
```

Also read `AGENTS.md`, the phase's section in `docs/phases.md`, `docs/code-map.md`, `docs/architecture.md`, and `phase-log/phase-<n>/plan.md`.

**For a later round:** list the earlier review threads with the query in step 5. For each thread the implementer marked fixed, check the fix is really there; if not, unresolve the thread and reply why. For each declined finding, either accept the evidence and resolve the thread, or reply why the finding stands.

## 2. Run

- `pnpm verify:phase <n>`, and note the result.
- `pnpm test:accept --repeat 3` for flakiness.
- `pnpm check:dupes`, `pnpm check:deps`, `pnpm check:unused`, and read their reports, not only the exit codes.
- `gh pr checks <pr>` for CI.
- If your tools include a code review skill (for example `/code-review`), run it on the PR as one more input for correctness bugs.

## 3. Check

Go through every dimension. A finding needs a location and evidence.

| Dimension | What to check |
|---|---|
| **Spec conformance** | Every exit check of the phase has a test, and the test proves what the check says (not a weaker version). `api/examples` weren't weakened. The API matches `api/*.d.ts`. Behaviour matches architecture.md, devx.md, live-mode.md |
| **Duplication** | No concern is implemented twice. Search for parallel versions of: id generation, signing, HTTP calls to the agent, polling and waiting, duration parsing, error mapping, redaction, payload building, store lookups. Compare every new module with `docs/code-map.md`; each must be listed, with one owner. Read the `check:dupes` report for near-copies |
| **Architecture** | Drivers don't import each other; core doesn't import drivers; actions are written once against `World`; generated code wasn't edited by hand |
| **Platform realism** | Payloads, headers, ids and error codes match the platform (schemas, the id format table in architecture.md 3.2). The fake refuses what the platform refuses |
| **Tests** | Acceptance tests drive reference agents built on official SDKs, not channelstack's own client code. No sleeps where a wait or the quiet detector belongs. Negative tests exist for refusals and errors |
| **Security** | No hard-coded secrets; secrets only from the CSPRNG module; files with secrets are 0600; tokens never logged, returned or recorded unredacted; the control API stays on loopback with the bearer token |
| **Dependencies** | Each new dependency is in the plan and PR body, justified, permissively licensed, maintained, pinned, and works in the compiled binary. Nothing hand-written that a listed dependency already does |
| **Simplicity** | No dead code, unused exports, speculative abstractions, or TODOs without an issue |
| **Docs and PR** | The phase's "Docs to update" list is done; `docs/code-map.md` matches the code; decisions are recorded in `docs/decisions/`; the PR checklist is truthful |

**Severity:**
- **blocking:** breaks the spec, an exit check, the rules in AGENTS.md, security, or duplicates logic.
- **should-fix:** a real problem that doesn't break those (unclear naming, a missing negative test, a weak error message).
- **nit:** taste. Never blocks.

## 4. Post the review on the PR

Post **one review per round** with an inline comment per finding. Findings that don't belong to a line go in the summary.

The implementer and the reviewer post from the same GitHub account, and GitHub doesn't let an account approve or request changes on its own PR. So the review's `event` is always `COMMENT`, and **the verdict is the first line of the summary**.

Write the review to a JSON file and post it:

```json
{
  "event": "COMMENT",
  "commit_id": "<head sha you reviewed>",
  "body": "Verdict: changes required\n\nPhase <n> review, round <k>.\n- Gate: `pnpm verify:phase <n>` passed\n- Flakiness: 3 of 3 runs green\n\nFindings without a line:\n- R<k>.4 [should-fix] …\n\nChecked and fine: architecture, security, dependencies …",
  "comments": [
    {
      "path": "server/src/drivers/slack/fake/chat.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "**R<k>.1 [blocking] Second HMAC implementation**\n\nEvidence: `chat.ts:42` computes the v0 signature itself; `server/src/core/signing/slack.ts` already does.\nRule: docs/code-map.md, \"Signing and verification\"; AGENTS.md, \"No duplicate implementations\".\nRequired change: use `signSlackRequest` from core and delete this copy."
    }
  ]
}
```

```bash
gh api repos/christian-bromann/channelstack/pulls/<pr>/reviews --method POST --input review.json
```

- Number findings `R<round>.<n>`, and put the severity in brackets at the start.
- **Verdict: approved** only when no blocking or should-fix finding is open (a should-fix may be deferred only with a linked issue). Otherwise **Verdict: changes required**.
- If the same blocking finding survives three rounds, the verdict is **Verdict: escalate to maintainer**. Stop there.

## 5. Useful query: review threads and their state

```bash
gh api graphql -f query='
  query($owner:String!, $repo:String!, $pr:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$pr) {
        reviewThreads(first:100) {
          nodes { id isResolved path line comments(first:20) { nodes { body author { login } } } }
        }
      }
    }
  }' -F owner=christian-bromann -F repo=channelstack -F pr=<pr>
```

Unresolve a thread you're reopening:

```bash
gh api graphql -f query='mutation($id:ID!){ unresolveReviewThread(input:{threadId:$id}){ thread { id } } }' -F id=<thread id>
```
