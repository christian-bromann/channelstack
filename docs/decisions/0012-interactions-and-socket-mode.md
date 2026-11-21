# 0012: Interactions, Socket Mode and the standard checks

Status: accepted, phase 2.

## Acting waits, reading waits

A test acts like a person, and a person waits for a button before clicking it.

- **Actions that need something the agent shows** (`click`, `select`, `pickPrompt`) are repeated by the SDK while the server answers `not_found`, up to the wait timeout; then the last refusal is the error, and it lists what was there. The route declares this (`retryWhile`), so every SDK gets it.
- **Reads of what the agent set aside for someone** (`thread.suggestedPrompts()`, `user.ephemeral()`) wait until the agent is quiet (`onceQuiet`), like `latestReply`.

Alternative: let the server hold the request until the control appears. Rejected: the one polling loop lives in the SDK runtimes (code map), and a held request can't be told apart from a hung one.

## Where interactions go

Slack has separate request URLs for events, interactivity and slash commands. Until config loading exists (issue #10), the fake sends all three to the one `CHANNELSTACK_SLACK_WEBHOOK_URL`, which is how Bolt and the Chat SDK serve them by default, and it accepts any slash command name.

## Socket Mode

- An app chooses Socket Mode by calling `apps.connections.open`. From then on deliveries go over its connection, not to its request URL. This is a second **transport** of the one delivery queue (`DeliveryTransport`), not a second queue: attempts, retries, the quiet rule and the event log are the same.
- While the app is disconnected, an attempt waits for it to reconnect until the ack window ends. That is what makes `drop_socket` survivable for an agent that reconnects.
- `drop_socket` cuts the connections once, without a goodbye. It is not stored like the Web API faults.
- The WebSocket is served by `serve.ts` (the only place that calls `Bun.serve`); the fake only sees a `SocketSession`, so its logic is unit-tested without a socket.

## The standard checks take two more options

`api/checks.d.ts` had `app`, `prompt`, `skip` and `timeout`. No prompt can be guessed that makes an arbitrary agent stream, or ask for an approval. So `ChecksOptions` gains `streamPrompt` and `approval: { prompt, button }` (a contract change, on purpose); without them those four checks are left out.

"Handles `msg_too_long`" is triggered with a fault on `chat.postMessage`. The sandbox recording showed that real Slack no longer refuses a 40,001-character message (it splits it), so length alone can't trigger it.

## Not verified against Slack

- After Stop, `chat.appendStream` and `chat.stopStream` answer with the error `stopped_by_user`, following docs/phases.md. The Chat SDK's adapter logs that as an unexpected error, so real Slack may answer differently.
- The event `agent_session_stopped` carries `channel`, `thread_ts`, `user` and `streaming_message_ts` (a list), the fields the Chat SDK's adapter reads.
- A `response_url` answer replaces the message the control was on unless it says `replace_original: false`, and an added message is ephemeral unless it says `in_channel`.
