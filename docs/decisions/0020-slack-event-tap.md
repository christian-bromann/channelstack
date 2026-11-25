# 0020: Slack's real events, tapped in the reference agent's process

Status: accepted, for [#28](https://github.com/christian-bromann/channelstack/issues/28).

The nightly differential run compares the shapes of the webhooks each platform really sends with
the fake's (live-mode.md 6). For GitHub, Linear and Notion, a tap sits between the relay channel
and the reference agent. Slack's agent receives in Socket Mode, so it has no relay to tap.

## Decision

When the run records, it starts Slack's reference agent through `scripts/lib/slack-event-tap.ts`.
That entry wraps Bolt's `App.prototype.processEvent` in the agent's own process. Each event's body
(the `event_callback`, or an interaction's payload) goes to the live run over Node's IPC channel,
and the recorder writes its shape. Bolt then handles the event, unchanged.

The recorder keys Slack's events by the event's type (`event_callback app_mention`), as it keys
GitHub's and Linear's by `action`. It also reads Slack's form-encoded interactions (`payload=`), so
the fake's `block_actions` are recorded too.

## Why

- The agent keeps its own connection to Slack. Nothing is relayed, forwarded or made up, so live
  mode's rule holds, and the tap is in the live run's scripts, not in the server.
- It needs nothing new in the sandbox: no second app, no request URL, no relay channel.
- What's recorded is what Bolt got, which is exactly what Slack sent over the socket.

## Alternatives considered

- **A second Slack app**, subscribed to the same events, with channelstack as its only consumer.
  Rejected: another app to create, install and keep in step. And its events would be the second
  app's, not the agent's (other ids, possibly other subscriptions).
- **The Events API through a relay channel**, as the other platforms do. Rejected: it changes how
  the sandbox app receives, so it no longer tests the Socket Mode agent, and it needs one more relay.
- **Rewriting the socket's URL** (`apps.connections.open`) to a proxy that copies the frames.
  Rejected: Bolt's Socket Mode client doesn't take the agent's API URL, so it would mean patching
  more of the agent, and it puts channelstack in the path of the agent's events.
