# 0010: The dev session and what the attach CLI needs from the server

Status: accepted, phase 1.

## Context

architecture.md says the CLI, the UI and MCP share a long-lived `dev` session. The attach CLI takes names, not ids (`--as ana`, `--in "#support"`, `last`), and creates people and channels the first time a name is used (devx.md 4a). The control API had no way to share a session or to find things by name.

## Decision

- `POST /sessions` takes an optional `name`. The open session of that name is returned if there is one, so whoever asks for `dev` gets the same session. Unnamed sessions, which tests use, are always new. A named session lives until it is closed or the server stops.
- Three reads, marked **experimental** because `api/*.d.ts` doesn't have them: a session's people, its conversations (the one with the newest message last), and a conversation's newest message. The CLI resolves names and `last` from these; the UI lists conversations with them.
- Name resolution lives in the CLI (`server/src/cli/slack.ts`), not in the server: the server's rule stays "names are unique per session" (decision 0006), and the CLI adds "use it if it exists, create it otherwise". A person who isn't in a channel yet is invited by someone who is, as on Slack.
- `last` is the newest message of the most recently active conversation; for `--thread last`, the thread that message is in.
- The CLI is part of the server binary and talks to the control API over HTTP like every other client. It finds the server through `--server` or `CHANNELSTACK_URL` (with `CHANNELSTACK_TOKEN`), otherwise through `server.json`.

## Alternatives considered

- **"Find or create" routes on the server.** Rejected: a second way to create things, with a rule tests don't want.
- **Keep `last` in a file next to `server.json`.** Rejected: the server already knows what was said last, and a file goes stale.
