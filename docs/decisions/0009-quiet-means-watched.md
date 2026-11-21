# 0009: What "the agent is quiet" means to a check

Status: accepted, phase 1.

## Context

Negative and exact-count matchers wait until the agent is quiet before they read (implementation-plan.md, exit check 1.5). Three cases showed that "no activity for `quietFor`" alone isn't enough.

## Decision

1. **A check watches for the whole window.** A negative or exact-count matcher waits until the session is quiet *and* at least `quietFor` has passed since the check started (`untilQuiet({ watching: true })`). An agent that is thinking makes no sound, so a session that went quiet a while ago says nothing about what arrives next. Reads such as `latestReply` keep the plain rule: there, something has just happened.
2. **A rate-limited agent isn't quiet.** When the fake answers 429, the session stays busy until the agent calls that method again, or until `Retry-After` plus a grace period has passed (`QuietDetector.expectMore` / `arrived`). The grace is 3 seconds, because Slack's own client adds 1 to 2 seconds of backoff on top of `Retry-After`.
3. **Open work has a name.** A driver reports what is still open in words (`a stream my-agent started and never stopped: "Thinking…"`). The quiet endpoint returns it, a wait that gives up prints it, and a failed matcher appends it. This is how the `mdac-220` bug gets a failure message that names the leftover message (exit check 1.4).

## Why

Each rule removes a way for a test to pass or fail for the wrong reason: a check that didn't look long enough, a check that ran during the agent's backoff, and a timeout that doesn't say what it was waiting for.

## Cost

A negative or exact-count matcher now takes at least `quietFor` (750 ms by default). `quietFor` is an option per matcher and per integration.

## Alternatives considered

- **Quiet since the last event only.** Rejected: it fails exit check 1.5 as written (a reply 500 ms after the check started).
- **A fixed, longer wait after a 429.** Rejected: slow when the agent retries quickly, and still a guess.
