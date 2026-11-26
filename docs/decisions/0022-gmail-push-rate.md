# 0022: Gmail's one push a second, held rather than dropped

Status: accepted, 2026-11-25, in phase 9.

## The platform's rule

Gmail sends at most one push notification a second for each watched mailbox: "The service drops
any user notifications exceeding that rate" ([Gmail push guide](https://developers.google.com/workspace/gmail/api/guides/push)).
A notification only says the mailbox's history moved on (`{ emailAddress, historyId }`); the
agent lists the history since the last id it handled. So two emails a few milliseconds apart
cause one push, and an agent that answers only the message the push seems to be about misses
the other.

## What the fake does

At most one push a second, per mailbox **and test session**. A change that comes sooner isn't
dropped: it is held, and pushed when the second is over, with the newest history id. An agent
that lists history from its last id sees both emails after that one push; one that reads only the
newest message misses the first, which is the bug `google.history` catches.

## Why not drop

- **Determinism.** Dropping a notification leaves the agent with nothing until the next one. In
  a test there may be no next one, and the test would wait for an answer that only a later,
  unrelated change would bring. Holding it gives the agent the same information Gmail would,
  at the latest a second later, every time.
- **Real Gmail doesn't promise the drop either.** The same guide says notifications may be
  "delayed or dropped": a held push is one of the things the agent must handle anyway.

## Why per session

Tests run side by side against one fake mailbox. Counting the second per mailbox only would let
one test's email hold back another's push, and tests would slow each other down by chance. Each
session's changes have their own second, as Resend's rate limit is counted per session.

## Alternatives

- **Drop, as Gmail says.** Rejected for the reasons above.
- **No limit.** One push per change hides the bug the limit exists to show: an agent that handles
  only the message a push is about passes every test and fails in production.
