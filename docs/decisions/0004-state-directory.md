# 0004: The state directory, and private servers

Status: accepted, phase 0.

## Context

The spec puts two files in `~/.channelstack`: `secrets.json` (fake tokens, once per install) and `server.json` (the control API's URL and bearer token, written on start). Two cases weren't covered:

1. A test run with `mode: "start"` starts a private server while the developer's long-lived server is running. If both write `~/.channelstack/server.json`, the second overwrites the first's token, and the CLI, UI and MCP lose the server they were attached to.
2. Tests of channelstack itself, and CI, must not read or write the real home directory.

## Decision

- **`CHANNELSTACK_HOME` overrides the state directory.** The default stays `~/.channelstack`. The directory is created with mode 0700 and every file in it with mode 0600, written atomically (`server/src/core/home`).
- **`server.json` belongs to the default server.** `channelstack start` writes `{ url, token, pid, version }` there and removes it on a clean stop.
- **A private server writes its token file somewhere else.** `--server-file <path>` (or `CHANNELSTACK_SERVER_FILE`) names the file. An SDK launcher in `start` mode passes a file in a fresh temporary directory, reads the URL and token from it, and deletes it when it stops the server. The shared `server.json` is never touched.
- **Private servers share the install's `secrets.json`.** The agent is configured once, from `channelstack env`; a private server must accept the same fake tokens, or the agent's `.env` would be wrong for it.
- **The bearer token is new on every start and never printed.** It reaches clients through the 0600 file only, or through `CHANNELSTACK_TOKEN` when the user sets it together with `CHANNELSTACK_URL`.

## Why

- **`auto` stays cheap.** A client reads one file, probes `/status` with the token, and attaches. No port scanning and no lock files.
- **No token on stdout.** A launcher could have read the token from the server's output, but that would put a credential in logs and CI output.

## Alternatives considered

- **One `server.json` with an entry per running server.** Rejected: it needs locking and cleanup of dead entries, and `auto` would have to choose between servers.
- **A temporary `CHANNELSTACK_HOME` per private server.** Rejected: it would generate different fake secrets, so an agent configured from `channelstack env` could not talk to that server.
