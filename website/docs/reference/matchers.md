---
title: "Matchers"
order: 3
description: "Every channelstack matcher: its subject, arguments and options, how it waits, what its failure message shows, and its pytest name."
---

# Matchers

Every matcher the [Vitest plugin](/docs/reference/vitest-plugin) adds to `expect`, with the pytest name where [pytest-channelstack](/docs/guide/pytest) has one. Why matchers wait the way they do is in [Waiting and quiet](/docs/guide/waiting-and-quiet).

```ts
await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /incident/i });
await expect(msg.thread).toHaveRepliesFrom(slack.app, { count: 1 });
await expect(channel).not.toHaveChannelMessageFrom("my-agent");
```

## How they wait

Every matcher is async: `await` it.

| Kind | Waits | Then |
|---|---|---|
| Positive | Polls (every 50ms) until the condition holds | Passes as soon as it holds; fails at `timeout` |
| Negative (`.not`) | Until the agent has been quiet for `quietFor`, watching for the whole window | Checks once |
| Exact count (`count`, `times`) | Until the agent has been quiet for `quietFor`, watching for the whole window | Checks once |

"Quiet" means no API call in flight, no delivery in flight or about to be retried, and no open stream, in the subject's session. A quiet wait that runs out of time fails with `Timed out after <n>ms waiting for the agent to be quiet for <n>ms`, plus what is still open.

Live, channelstack can't see when the agent is done: proxy mode will, once it reads the agent's calls back live ([#24](https://github.com/christian-bromann/channelstack/issues/24)). Until then, once a session has acted live, its quiet check is refused with `action_requires`, so negative and exact-count matchers skip the test there.

| Option | Type | Default | On |
|---|---|---|---|
| `timeout` | `Duration` | The plugin's `timeout` (`10s`) | Every matcher but `toBeEphemeralFor` |
| `quietFor` | `Duration` | The plugin's `quietFor` (`750ms`) | Every matcher under `.not`, and exact-count ones |

A failure message says what was expected, then what is there. When the check fails and the agent left something open in the session (a stream it never stopped, a delivery about to be retried), it ends with `Still open: …`.

Text arguments (`text`, a `string | RegExp`) match a string by substring and a `RegExp` by `test`. An author (`AuthorRef`) is a handle, matched by `id`, or a string, matched against the `name` or the `id`.

Text matchers read the transcript (for example [`SlackTranscript`](/docs/reference/api/slack#slacktranscript)): what a person would see, not raw payloads.

## Any transcript

| Matcher | Subject | Arguments and options | Waits | Fails with | pytest |
|---|---|---|---|---|---|
| `toContainText(text, options?)` | Anything with `transcript()`: a conversation, thread, message, issue, PR, review comment, Linear comment or session, Notion page or discussion | `text: string \| RegExp`; `from?: AuthorRef`, `as?: Principal` (read as this person: their ephemeral messages included), `count?: number`, `timeout`, `quietFor` | Polls; with `count`, quiet then once | `Expected text matching "…", found <n>. A person sees:` and every entry as `author: text` | `to_contain_text`, `not_to_contain_text` |

## Slack

| Matcher | Subject | Arguments and options | Waits | Fails with | pytest |
|---|---|---|---|---|---|
| `toHaveReplyFrom(author, options?)` | `SlackThread`, or a `SlackConversation` (a DM: everything in it, threads included) | `author: AuthorRef`; `text?: string \| RegExp`, `timeout` | Polls | `Expected a reply from <name> matching "…". The thread has:` and every reply | `to_have_reply_from(author, *, text=, timeout=)`, `not_to_have_reply_from(…, quiet_for=)` |
| `toHaveRepliesFrom(author, options)` | `SlackThread` or `SlackConversation` | `author: AuthorRef`; `count: number` (required), `text?`, `timeout`, `quietFor` | Quiet, then once | `Expected exactly <n> replies from <name>, found <m>:` and the matching replies | `to_have_replies_from(author, *, count=, text=, timeout=, quiet_for=)`, `not_to_have_replies_from(…)` |
| `toHaveChannelMessageFrom(author, options?)` | `SlackConversation` | `author: AuthorRef`; `timeout`, `quietFor`. Top-level messages only, outside any thread | Polls | `Expected a message from <name> in the channel itself, found none`; under `.not`, the messages found | `to_have_channel_message_from(author, *, timeout=)`, `not_to_have_channel_message_from(…, quiet_for=)` |
| `toHaveStreamingReplyFrom(author?, options?)` | `SlackThread` or `SlackConversation` | `author?: AuthorRef` (anyone if left out); `timeout` | Polls | `Expected a reply being streamed by <name>. The thread has:` and each message with its stream state | `to_have_streaming_reply_from(author=None, *, timeout=)`, `not_to_have_streaming_reply_from(…, quiet_for=)` |
| `toHaveStatus(state, options?)` | `SlackThread` | `state: "working" \| "streaming" \| "stopped" \| "idle"`; `timeout` | Polls | `Expected the thread to be <state>, it is <state> ("<status line>")` | `to_have_status(expected, *, timeout=)`, `not_to_have_status(…, quiet_for=)` |
| `toHaveStatusText(text, options?)` | `SlackThread` | `text: string \| RegExp` (the `assistant.threads.setStatus` line); `timeout` | Polls | `Expected the status line to match "…", it is "…"` or `there is none` | `to_have_status_text(text, *, timeout=)`, `not_to_have_status_text(…, quiet_for=)` |
| `toHaveButton(label, options?)` | `SlackMessage`; or a `SlackThread` or `SlackConversation` (the app's latest message there) | `label: string \| RegExp`; `timeout` | Polls | `Expected a button matching "…". Buttons there:` and the labels, or `none` | `to_have_button` |
| `toHaveReaction(emoji, options?)` | `SlackMessage` | `emoji: string` (`":eyes:"` or `"eyes"`); `by?: AuthorRef`, `timeout` | Polls | `Expected a :eyes: reaction by <name>. Reactions there:` and each with who added it | `to_have_reaction(emoji, *, by=, timeout=)`, `not_to_have_reaction(…, quiet_for=)` |
| `toHaveOpenedModal(title?, options?)` | `SlackUser` | `title?: string \| RegExp`; `timeout`. A modal opened for this person, submitted or not | Polls | `Expected a modal titled "…" to have been opened. Opened:` and the titles, or `none` | — |
| `toBeEphemeralFor(user)` | `SlackMessage` | `user: SlackUser` | Doesn't wait: reads `visibleTo` once | `Expected the message to be visible only to <name>, everyone can see it` (or `only <name> can`) | — |

Live, `toHaveStatus`, `toHaveStatusText` and `toHaveOpenedModal` read what needs proxy mode, which live doesn't read back yet ([#24](https://github.com/christian-bromann/channelstack/issues/24)), so they skip the test (`action_requires`).

## Comments: GitHub, Linear, Notion

| Matcher | Subject | Arguments and options | Waits | Fails with | pytest |
|---|---|---|---|---|---|
| `toHaveCommentFrom(author, options?)` | Anything with `comments()`: `GitHubIssue`, `GitHubPullRequest`, `LinearIssue`, `NotionDiscussion` | `author: AuthorRef`; `text?: string \| RegExp`, `timeout` | Polls | `Expected a comment from <name> matching "…". The conversation has:` and every comment | `to_have_comment_from` |
| `toHaveCommentsFrom(author, options)` | The same | `author: AuthorRef`; `count: number` (required), `timeout`, `quietFor` | Quiet, then once | `Expected exactly <n> comments from <name>, found <m>:` and every comment | `to_have_comments_from` |

A `NotionPage` has no `comments()`: check one of its `discussions()`.

## GitHub

| Matcher | Subject | Arguments and options | Waits | Fails with | pytest |
|---|---|---|---|---|---|
| `toHaveReviewComment(expected, options?)` | `GitHubPullRequest` | `expected: { path?: string; line?: number; from?: AuthorRef; text?: string \| RegExp }`, every given field must match; `timeout` | Polls | `Expected a comment on the diff on <path>:<line> from <name> matching "…". The diff has:` and each as `author on path:line: body` | — |
| `toHaveReviewFrom(author, options?)` | `GitHubPullRequest` | `author: AuthorRef`; `state?: "COMMENTED" \| "APPROVED" \| "CHANGES_REQUESTED"`, `timeout` | Polls | `Expected a review from <name> with state <state>. Reviews there:` and each with its state | — |
| `toHaveCheckRun(name, options?)` | `GitHubPullRequest` (its newest commit) or `GitHubCommit` | `name: string \| RegExp` (a string must equal the name); `status?: "queued" \| "in_progress" \| "completed"`, `conclusion?: "success" \| "failure" \| "neutral" \| "cancelled" \| "skipped" \| "timed_out" \| "action_required"`, `timeout` | Polls | `Expected a check run "…" (<status>, <conclusion>). Check runs there:` and each with status and conclusion | — |
| `toHaveLabel(name, options?)` | `GitHubIssue` or `GitHubPullRequest` (also a `LinearIssue`) | `name: string`, compared case-insensitively; `timeout` | Polls | `Expected the label "…". Labels there:` and the labels, or `none` | — |
| `toBeMerged(options?)` | `GitHubPullRequest` | `timeout` | Polls | `Expected the pull request to be merged` | — |

Live, the reads behind `toHaveReviewComment`, `toHaveReviewFrom`, `toHaveCheckRun` and `toBeMerged` aren't built yet, so they skip the test (`unsupported_in_live`).

## Linear

| Matcher | Subject | Arguments and options | Waits | Fails with | pytest |
|---|---|---|---|---|---|
| `toHaveSessionState(state, options?)` | `LinearAgentSession`, or a `LinearIssue` (its latest session) | `state: "pending" \| "active" \| "awaitingInput" \| "complete" \| "error" \| "stale"`; `timeout` | Polls | `Expected the agent session to be <state>, it is <state>` (`no session` when the issue has none) | `to_have_session_state` |
| `toHaveActivity(expected, options?)` | `LinearAgentSession` or `LinearIssue` (its latest session) | `expected: { type?: "thought" \| "action" \| "elicitation" \| "response" \| "error"; from?: AuthorRef; text?: string \| RegExp }`, every given field must match; `timeout`. People's prompts don't count | Polls | `Expected a <type> from <name> matching "…". The session has:` and each as `author (type): body` | `to_have_activity` |
| `toBeAssignedTo(user, options?)` | `LinearIssue` | `user: Principal \| undefined` (`undefined`: no one), compared by `id`; `timeout` | Polls | `Expected the issue to be assigned to <name>, it is assigned to <name>` (or `no one`) | — |
| `toBeDelegatedTo(app, options?)` | `LinearIssue` | `app: Principal \| undefined` (`undefined`: none), compared by `id`; `timeout` | Polls | `Expected the issue to be delegated to <name>, it is delegated to <name>` (or `no one`) | — |
| `toHaveState(name, options?)` | `LinearIssue` | `name: string`, the workflow state's name, compared case-insensitively; `timeout` | Polls | `Expected the issue to be in "…", it is in "…"` | — |

## Notion

| Matcher | Subject | Arguments and options | Waits | Fails with | pytest |
|---|---|---|---|---|---|
| `toHaveBlock(text, options?)` | `NotionPage` | `text: string \| RegExp`, matched against each block's text at any depth (a child page's title counts); `timeout` | Polls | `Expected the page to have a block matching "…". Its blocks:` and each block's text | — |
| `toHavePropertyValue(name, value, options?)` | `NotionPage` (a database row) | `name: string`, `value: unknown`, compared with Vitest's equality, so asymmetric matchers (`expect.any(Number)`) work; `timeout` | Polls | `Expected <name> to be <value>, it is <value>` | — |

Live, `toHavePropertyValue` reads a property, which isn't built live yet: it skips the test (`unsupported_in_live`).

## Deliveries

Subject: any delivery ([`SlackDelivery`](/docs/reference/api/slack#slackdelivery), [`GitHubDelivery`](/docs/reference/api/github#githubdelivery), [`LinearDelivery`](/docs/reference/api/linear#lineardelivery), [`NotionDelivery`](/docs/reference/api/notion#notiondelivery)). They read `refresh()`, which is fake only except on GitHub; live elsewhere they skip the test (`unsupported_in_live`).

| Matcher | Subject | Arguments and options | Waits | Fails with | pytest |
|---|---|---|---|---|---|
| `toBeAccepted(options?)` | A delivery | `within?: Duration` (also require `durationMs <= within`), `timeout`. Reads the first attempt that wasn't forged | Polls | `Expected delivery <id> to be accepted within <n>ms, its first attempt is <status> (HTTP <code>) after <n>ms` | — |
| `toBeRejected(options?)` | A delivery that was resent forged (`resend({ badSignature: true })` or `{ stale: true }`) | `timeout`. Reads the latest forged attempt: it must be `failed` with a 4xx | Polls | `Expected the forged attempt of delivery <id> to be rejected with a 4xx, the agent answered <code>`; with no forged attempt, `… but no forged attempt was sent. Call delivery.resend({ badSignature: true }) first` | — |
| `toBeRetried(options?)` | A delivery | `times?: number` (exact), `timeout`, `quietFor`. Counts attempts that weren't forged, minus the first | Polls; with `times`, quiet then once | `Expected delivery <id> to be retried <n> times, it was retried <m> times` | — |

## API calls

| Matcher | Subject | Arguments and options | Waits | Fails with | pytest |
|---|---|---|---|---|---|
| `toHaveReceivedCall(operation, options?)` | A channel fixture: `slack`, `github`, `linear`, `notion` | `operation: string \| RegExp` (a string must equal the [operation](/docs/reference/api/slack#slackapicall)); `error?: string` (only calls that returned this error), `times?: number` (exact), `timeout`, `quietFor` | Polls; with `times`, quiet then once | `Expected the agent to call "…" <n> times with error <code>, found <m>. Its calls:` and each as `operation → error` | `to_have_received_call(operation, *, error=, times=, timeout=, quiet_for=)`, `not_to_have_received_call(operation, *, error=, timeout=, quiet_for=)` |

It reads `calls()`, so live it needs proxy mode, which doesn't read the agent's calls back live yet ([#24](https://github.com/christian-bromann/channelstack/issues/24)): the test is skipped (`action_requires`).

## Read methods

Every matcher is built on a plain read, so a test can read the value itself:

| Matcher | Reads |
|---|---|
| `toContainText` | `transcript()` |
| `toHaveReplyFrom`, `toHaveRepliesFrom`, `toHaveStreamingReplyFrom` | `thread.replies()`, or a conversation's `transcript()` |
| `toHaveChannelMessageFrom` | `conversation.messages()` |
| `toHaveStatus`, `toHaveStatusText` | `thread.status()` |
| `toHaveButton` | the transcript entry's `controls` |
| `toHaveReaction` | `message.reactions()` |
| `toHaveOpenedModal` | `user.modals()` |
| `toBeEphemeralFor` | `message.visibleTo` |
| `toHaveCommentFrom`, `toHaveCommentsFrom` | `comments()` |
| `toHaveReviewComment`, `toHaveReviewFrom` | `pr.reviewComments()`, `pr.reviews()` |
| `toHaveCheckRun` | `checkRuns()` |
| `toHaveLabel` | `issue.labels()` |
| `toBeMerged` | `pr.merged()` |
| `toHaveSessionState`, `toHaveActivity` | `session.state()`, `session.activities()` |
| `toBeAssignedTo`, `toBeDelegatedTo`, `toHaveState` | `issue.assignee()`, `issue.delegatedTo()`, `issue.state()` |
| `toHaveBlock` | `page.blocks()` |
| `toHavePropertyValue` | `page.property(name)` |
| `toBeAccepted`, `toBeRejected`, `toBeRetried` | `delivery.refresh()`, then `attempts` |
| `toHaveReceivedCall` | `fixture.calls()` |

A matcher given a subject without the read it needs throws a `TypeError`, e.g. `This matcher needs a thread or a conversation`.
