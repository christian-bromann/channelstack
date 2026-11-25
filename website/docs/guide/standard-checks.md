---
title: "Standard checks"
order: 6
description: "Add channelstack's standard behaviour checks to a Vitest suite: what each one catches, the options they need, and how to skip one."
---

# Standard checks

The standard checks are a set of tests for the bugs agents commonly have on each platform: answering twice, answering in the wrong place, answering themselves, mishandling a retry. This page shows how to add them to your suite, what each check catches, and how to leave one out.

## Add the checks

```ts title="test/checks.test.ts"
import { githubChecks, linearChecks, notionChecks, slackChecks } from "channelstack/checks";

slackChecks({
  app: "my-agent",
  streamPrompt: "write a long report on Q3",
  approval: { prompt: "@my-agent deploy web to staging", button: "Approve" },
});
githubChecks({ app: "my-agent" });
linearChecks({ app: "my-agent" });
notionChecks({ app: "my-agent", prompt: "@my-agent summarize this page" });
```

Each call registers ordinary Vitest tests in the file it's called from, on the fixtures and matchers of `channelstack/vitest`, so the [plugin](/docs/guide/writing-tests#add-the-plugin) must be set up. The tests are grouped in a `describe` named after the platform and the app (`slack checks: my-agent`), and each test name ends in the check's id:

```
✓ slack checks: my-agent > replies once to a DM [slack.dm-once]
✓ slack checks: my-agent > survives Slack's retry after 3 seconds [slack.retry]
✓ github checks: my-agent > every check run it starts reaches a conclusion [github.check-run]
```

A check you skip, or one whose option you didn't give, isn't registered at all, so it doesn't show up in the report.

Call only the functions for the platforms your agent is on. The checks are written against the public test API, the same one your own tests use, so a failing check reads like one of your tests failing: the matcher's message says what a person would have seen.

## Options

| Option | Default | What it's for |
|---|---|---|
| `app` | required | The app's name as people mention it, `my-agent` |
| `prompt` | `@<app> hello` | Text that makes the agent answer. For Linear it's the title of the issue that gets delegated, default `Look into this` |
| `streamPrompt` | none | Text that makes the agent stream a longer answer in a DM. Without it, the two stream checks are left out |
| `approval` | none | `{ prompt, button }`: text that makes the agent ask for an approval, and the label of the button it shows. Only a workspace admin may press it. Without it, the two click checks are left out |
| `skip` | `[]` | Check ids to leave out, for example `["slack.stream-stop"]`. An id that no check has throws, with the list of ids |
| `timeout` | the plugin's `timeout` | How long each check waits for the agent |

Pick prompts your agent answers quickly and in a single message. With a real model, a short, plain prompt keeps the checks fast. With a fake model, use one your script already handles.

## Slack checks

| Id | What the test does | What it catches |
|---|---|---|
| `slack.dm-once` | Ana DMs the prompt; expects exactly one reply | Two answers to one DM |
| `slack.mention-once` | Ana mentions the app in a channel; expects exactly one reply | Answering both the `app_mention` and the `message` event for the same message |
| `slack.in-thread` | A mention in a channel; expects a reply in the thread, and no message in the channel itself | Answers that land in the channel instead of the thread |
| `slack.retry` | Retries the mention's event after 3 seconds, as Slack does; expects one reply | Answering again on Slack's retry |
| `slack.redelivery` | After the reply, sends the same event again, unchanged; expects one reply | An agent that only checks the retry headers, not the `event_id` |
| `slack.ignores-bots` | Another bot mentions the app; expects no reply | Bot-to-bot loops |
| `slack.bad-signature` | Resends a DM's event with a wrong signature; expects a 4xx | Turned-off or broken signature checks. Over Socket Mode there's no signature, and the check passes without sending anything |
| `slack.ack` | A DM; expects the delivery acknowledged within 3 seconds | Work done before the acknowledgement |
| `slack.msg-too-long` | Slack refuses the agent's next `chat.postMessage` once with `msg_too_long`; expects exactly one reply in the end | An agent that gives up, or crashes, when a message is too long |
| `slack.stream-stop` | Needs `streamPrompt`. Expects a streaming reply that ends `completed`, and the thread `idle` | A stream that is never stopped, leaving "Thinking…" up |
| `slack.stop` | Needs `streamPrompt`. Ana presses Stop during the stream; expects the thread `stopped` and exactly one reply | Writing on after Stop |
| `slack.click-unauthorized` | Needs `approval`. A non-admin presses the button; expects the thread to still hold only the ask | Acting on, or answering publicly, a click from someone who may not act |
| `slack.double-click` | Needs `approval`. An admin presses the button twice at once; expects exactly one new message in the thread | Acting twice on a double click |

`slack.double-click` counts messages: the agent should answer one approval with exactly one new message in the thread. Replacing the question as well is fine, and so is removing the button once it has acted. An agent that answers only by editing the question, or with several messages, should skip this check.

`slack.msg-too-long` injects a [fault](/docs/guide/delivery-and-failures#faults), which applies to the whole workspace while it lasts. Run the Slack checks where no other test posts at the same moment, or skip that check in a parallel suite.

## GitHub checks

Each check works in a fresh repository with the App installed and Ana as a collaborator.

| Id | What the test does | What it catches |
|---|---|---|
| `github.ignores-own-comments` | Ana mentions the app in an issue; expects exactly one comment from it | An agent that answers its own comment, again and again |
| `github.one-comment` | Ana mentions it twice, waiting for each answer; expects exactly two comments | More than one comment per trigger |
| `github.review-thread` | Ana mentions the app in a comment on a pull request's diff; expects one reply, from the app, in that thread | Answers that go to the pull request's conversation instead of the review thread, or nowhere |
| `github.redelivery` | Redelivers the comment's webhook with the same GUID; expects one comment | Handling a redelivery from the App's settings as a new event |
| `github.check-run` | Opens a pull request; once the agent is quiet, expects every check run to be completed | Check runs left `queued` or `in_progress`, which block merging |
| `github.bad-signature` | Resends the webhook with a wrong signature; expects a 4xx | Turned-off webhook verification |

`github.check-run` passes for an agent that creates no check runs. Skip it if your App doesn't use them, to keep the report honest.

## Linear checks

Each check creates an issue titled with `prompt` and delegates it to the app, which opens an agent session.

| Id | What the test does | What it catches |
|---|---|---|
| `linear.first-activity` | Expects some activity from the agent within 10 seconds | A slow first response; Linear shows the session as unresponsive after that |
| `linear.ends-turn` | Expects the session to reach `complete`, `awaitingInput` or `error` | A session left `active` after the work is done |
| `linear.stop` | After the first activity, Ana presses Stop; expects `complete` or `error` | Ignoring the stop signal |
| `linear.redelivery` | After the turn ends, redelivers the webhook that opened the session; expects at most one `response` activity | Starting the work over on a redelivery |
| `linear.stale` | Resends that webhook with a `webhookTimestamp` two minutes old; expects a 4xx | Missing replay protection: Linear's receivers should refuse webhooks more than a minute old |
| `linear.bad-signature` | Resends it with a wrong signature; expects a 4xx | Turned-off webhook verification |

## Notion checks

Each check has Ana post `prompt` as a comment on a page connected to the integration.

| Id | What the test does | What it catches |
|---|---|---|
| `notion.reply-in-discussion` | Expects a reply in Ana's discussion, and no other discussion on the page | Answers posted as a new page comment, which the person doesn't see where they asked |
| `notion.ignores-own-comments` | Expects exactly one comment from the integration | An integration that answers its own comment |
| `notion.redelivery` | Sends the comment's webhook again; expects one comment | Handling Notion's retry as a new comment |
| `notion.bad-signature` | Resends the webhook with a wrong signature; expects a 4xx | Turned-off `X-Notion-Signature` checks |

## Skipping a check

List the ids in `skip`:

```ts
slackChecks({ app: "my-agent", skip: ["slack.msg-too-long"] });
githubChecks({ app: "my-agent", skip: ["github.check-run"] });
```

A check that needs an option you didn't give (`streamPrompt`, `approval`) is left out on its own, as if it were in `skip`. Leave a check out only when it doesn't apply to your agent; when a check fails for a real bug, fix the agent.

To run a single check while you work on its bug, filter by its id, which is part of the test name:

```bash
npx vitest run test/checks.test.ts -t "slack.retry"
```

The id lists are exported too, as `SLACK_CHECKS`, `GITHUB_CHECKS`, `LINEAR_CHECKS` and `NOTION_CHECKS`, for a script that builds `skip` from them.

## In live mode

Most checks are about delivery: retries, redeliveries, forged signatures, acknowledgement times. Live, the real platform delivers to your agent, so a message or comment has no delivery to retry or forge, and the checks don't all skip:

| Checks | Live |
| --- | --- |
| `slack.bad-signature`, `slack.ack`, `github.bad-signature`, `notion.bad-signature` | **Fail**, with "caused no delivery". List them in `skip` in a live run |
| `slack.retry`, `slack.redelivery`, `github.redelivery`, `notion.redelivery` | Step over the delivery, then skip at their exact count, because waiting for quiet needs proxy mode live ([Live mode](/docs/guide/live-mode#what-skips-and-what-fails)) |
| `linear.redelivery`, `linear.stale`, `linear.bad-signature` | Skip, with the reason |
| `slack.msg-too-long`, `slack.stop` and the others that use a fault, Stop or an exact count | Skip, with the reason |
| `slack.in-thread`, `slack.ignores-bots`, `slack.stream-stop`, `github.check-run` | Skip, with the reason: they wait for quiet, read the status line or create a bot user, which live mode can't do yet |

Four run against the real platform: `github.review-thread`, `linear.first-activity`, `linear.ends-turn` and `notion.reply-in-discussion`. Making every delivery check skip live with its own reason is [#46](https://github.com/christian-bromann/channelstack/issues/46). The fake run on every pull request runs them all.
