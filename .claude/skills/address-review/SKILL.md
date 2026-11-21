---
name: address-review
description: Work through a channelstack phase review on its GitHub pull request finding by finding — fix, decline with evidence, or defer each one, reply in its thread, resolve the threads, and request the next review round. Use after review-phase posts "Verdict: changes required".
---

# Address a review on the PR

You're the implementer. The latest review on the phase PR lists findings as inline comments (and maybe in its summary). Every finding gets an outcome and a reply; none are skipped.

## 1. Collect the findings

```bash
gh pr view <pr> --comments      # the review summary and its findings without a line
```

and the review threads with the query in `review-phase`, step 5. Work only on unresolved threads and the summary's findings.

## 2. Handle each finding

In order of severity (blocking, then should-fix, then nits):

- **Fix it** when the finding is right. Fix the cause, not the symptom: if it's a duplicate implementation, delete one version and move every caller to the remaining one, then update `docs/code-map.md`. Add or adjust a test that would have caught it. Push the fix as a new commit; don't force-push, so the review history stays intact.
- **Decline it** only when the finding is wrong, with evidence (a spec section, a test, a platform doc). Declining a blocking finding needs the maintainer: reply in the thread, add a PR comment saying **needs maintainer** with the finding number, and stop.
- **Defer it** only for should-fix and nit findings, with an issue:
  ```bash
  gh issue create --title "<finding title>" --body "From PR #<pr>, finding R<k>.<n>: …" --label phase-<n>
  ```
  Blocking findings are never deferred.

## 3. Reply in every thread

Reply to the finding's inline comment (use the id of the thread's first comment):

```bash
gh api repos/christian-bromann/channelstack/pulls/<pr>/comments/<comment id>/replies \
  --method POST -f body="Fixed in <sha>: <what changed>. Verified by <test name>."
```

| Outcome | Reply | Resolve the thread? |
|---|---|---|
| Fixed | `Fixed in <sha>: …. Verified by …` | Yes |
| Deferred | `Deferred to #<issue>: <why it can wait>` | Yes |
| Declined | `Declined: <evidence>` | **No**, the reviewer decides |

Resolve a thread:

```bash
gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread { isResolved } } }' -F id=<thread id>
```

For findings in the review summary (no thread), answer them all in one PR comment with the same table:

```bash
gh pr comment <pr> --body-file response.md
```

## 4. Before asking for the next round

- `pnpm verify:phase <n>` passes, and CI on the latest commit is green (`gh pr checks <pr>`).
- Every thread is either resolved or has a reply. Count the unresolved ones:
  ```bash
  gh api graphql -f query='
    query($owner:String!, $repo:String!, $pr:Int!) {
      repository(owner:$owner, name:$repo) { pullRequest(number:$pr) {
        reviewThreads(first:100) { nodes { isResolved } } } } }' \
    -F owner=christian-bromann -F repo=channelstack -F pr=<pr> \
    --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length'
  ```
- Post a PR comment: `Round <k> addressed: <x> fixed, <y> deferred, <z> declined. Ready for round <k+1>.`

Then start `review-phase` again **in a fresh context** for round `<k+1>`. Repeat until a round says **Verdict: approved**, then close and merge (`implement-phase`, step 6).
