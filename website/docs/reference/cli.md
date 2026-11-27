---
title: "CLI"
order: 1
description: "Every channelstack command and flag: start, env, the attach commands, mcp, and the live-mode commands, with their output and exit codes."
section: "Tools"
---

# CLI

Every `channelstack` command, its flags, what it prints and how it exits. For the workflow around them, see [The dev loop](/docs/guide/dev-loop).

```bash
npx channelstack                  # start the server
npx channelstack env >> .env      # the agent's settings
npx channelstack slack say --as ana --in "#support" "@my-agent hi"
npx channelstack show
```

## Commands

| Command | Does |
|---|---|
| [`channelstack [start]`](#channelstack-start) | Start the server |
| [`channelstack env`](#channelstack-env) | Print `.env` lines for the app |
| [`channelstack slack say`](#channelstack-slack-say) | Post a message as a person |
| [`channelstack slack reply`](#channelstack-slack-reply) | Reply in a thread as a person |
| [`channelstack slack react`](#channelstack-slack-react) | React to a message as a person |
| [`channelstack slack click`](#channelstack-slack-click) | Click a button as a person |
| [`channelstack slack stop`](#channelstack-slack-stop) | Press Stop on the agent's work in a thread |
| [`channelstack show`](#channelstack-show) | Print the latest conversation as a person reads it |
| [`channelstack tail`](#channelstack-tail) | Print deliveries and API calls as they happen |
| [`channelstack deliveries`](#channelstack-deliveries) | List what was delivered to the app |
| [`channelstack redeliver`](#channelstack-redeliver) | Deliver something again |
| [`channelstack ui`](#channelstack-ui) | Print a one-time link to the UI |
| [`channelstack mcp`](#channelstack-mcp) | Serve the attach commands as MCP tools |
| [`channelstack doctor`](#channelstack-doctor) | Check live credentials, allowlists and browser sessions |
| [`channelstack login`](#channelstack-login) | Save a browser session for the browser actor |
| [`channelstack sweep`](#channelstack-sweep) | Remove what crashed live runs left |
| [`channelstack secrets rotate`](#channelstack-secrets-rotate) | Replace every fake token and signing secret |
| [`channelstack ca rotate`](#channelstack-ca-rotate) | Replace proxy mode's CA |
| `channelstack --version`, `-v` | Print the version |
| `channelstack --help`, `-h` | Print the usage |

The attach CLI has Slack commands only. GitHub, Linear, Notion, Resend, Google and Twilio are driven from tests.

## Exit codes

| Code | When |
|---|---|
| `0` | The command did what it says. `start` exits `0` after a clean stop |
| `1` | Anything went wrong: a bad flag, no server to attach to, a refusal from the server, an unknown command. The message goes to stderr, prefixed `channelstack: `. `doctor`, `login` and `sweep` also exit `1` when their check fails (see each) |

## Attaching to the running server

`env`, `slack …`, `show`, `tail`, `deliveries`, `redeliver`, `ui` and `mcp` talk to a running server through its control API.

| Flag | Default | Meaning |
|---|---|---|
| `--server <url>` | `CHANNELSTACK_URL` | The server to attach to. With an explicit URL, the token comes from `CHANNELSTACK_TOKEN` |
| `--server-file <path>` | `CHANNELSTACK_SERVER_FILE`, else `<home>/server.json` | Where to read the server's URL and token when no URL is given |

| Message | Cause |
|---|---|
| `` no running server found. Start one with `channelstack start`. `` | No URL given and no server file |
| `CHANNELSTACK_TOKEN is needed to talk to <url>.` | A URL without a token |
| `` the server at <url> isn't reachable. Start one with `channelstack start`. `` | Nothing answers there |

The attach commands act in one long-lived session named `dev`, which the CLI, the UI and `mcp` share. People and channels are created there on first use, by name.

Where a command takes a message, `last` means the newest message of the most recently active conversation in the `dev` session. A message can also be named `<channel id>:<ts>`, as `slack say` and the other `slack` commands print them.

## `channelstack start`

```bash
channelstack [start] [--no-portless] [--port <n>] [--server-file <path>] [--log-level <level>]
                     [--proxy] [--proxy-port <n>] [--record <dir>]
```

`start` is the default command. The server runs in the foreground until `SIGINT`, `SIGTERM` or `SIGHUP`, then stops cleanly: live sessions remove what they created, and the server file and portless names are removed.

| Flag | Default | Meaning |
|---|---|---|
| `--no-portless` | off | One loopback port with path prefixes (`http://127.0.0.1:4500/slack`) instead of `*.localhost` names |
| `--port <n>` | `0` with portless (a free port), `4500` without | The loopback port. `0` picks a free one |
| `--server-file <path>` | `CHANNELSTACK_SERVER_FILE`, else `<home>/server.json` | Where to write the control API's URL and token (0600) |
| `--log-level <level>` | `CHANNELSTACK_LOG_LEVEL`, else `info` | `debug`, `info`, `warn`, `error` or `silent`. Logs go to stderr |
| `--proxy` | off | Also run an HTTP proxy for apps with hard-coded hosts: `slack.com`, `api.github.com`, `api.linear.app`, `api.notion.com`, `api.resend.com`, `gmail.googleapis.com`, `oauth2.googleapis.com` and `www.googleapis.com` go to the fakes, every other host passes through. See [Proxy mode](/docs/guide/proxy-mode) |
| `--proxy-port <n>` | `7464` | The proxy's loopback port. `0` picks a free one. Needs `--proxy` |
| `--record <dir>` | none | Write the shape of every exchange with those hosts, and of every webhook, to `<dir>/shapes.jsonl`: structure only, never a value. Needs `--proxy` |

It reads `CHANNELSTACK_HOME`, `CHANNELSTACK_SEED`, `CHANNELSTACK_<CHANNEL>_WEBHOOK_URL` and the live credentials from the environment ([Environment variables](/docs/reference/environment-variables)).

Prints:

```
channelstack <version> · in-memory

  Control  https://channelstack.localhost/_channelstack
  echo     https://echo.localhost
  slack    https://slack.localhost
  github   https://github.localhost
  linear   https://linear.localhost
  notion   https://notion.localhost
  resend   https://resend.localhost
  google   https://google.localhost
  UI       https://channelstack.localhost/?login=…

  `channelstack env` prints tokens and URLs as .env lines
```

With `--proxy`, a `Proxy` line adds the proxy's URL and the CA file, and the last line points at `channelstack env --proxy`. The UI link signs one browser in, once; `channelstack ui` prints a fresh one. `echo` is channelstack's own minimal test platform.

| Error | Cause |
|---|---|
| `A channelstack server is already running at <url> (pid <n>, from <file>). …` | The server file belongs to a server that answers. Stop it, or pass another `--server-file` |
| `--proxy-port needs --proxy`, `--record needs --proxy` | |
| `--port must be a port number, got "…"` | Also for `--proxy-port` |
| `portless isn't installed. Install it (npm install -g portless) or start with --no-portless.` | |

## `channelstack env`

```bash
channelstack env [--proxy] [--server <url>]
```

Prints `KEY=value` lines for the app, one per line, from the running server, so the URLs match how it was started.

| Flag | Meaning |
|---|---|
| `--proxy` | For proxy mode: the proxy and the CA the app trusts, instead of the API URLs. Fails with `channelstack env --proxy needs proxy mode: start the server with --proxy` when the server runs without `--proxy` |

What it prints is listed in [Environment variables](/docs/reference/environment-variables#what-channelstack-env-prints). A channel that runs live prints nothing: the app keeps its own configuration.

## `channelstack slack say`

```bash
channelstack slack say --as <name> --in "#<channel>" "<text>"
```

| Flag | Required | Meaning |
|---|---|---|
| `--as <name>` | yes | Who speaks. Created the first time the name is used; names match case-insensitively |
| `--in "#<channel>"` | yes | Where. Created with the person and the app in it the first time; if it exists and the person isn't in it, someone in it invites them |

`@name` in the text becomes a real mention. Prints `<name> said it in #<channel> (<channel id>:<ts>)`.

## `channelstack slack reply`

```bash
channelstack slack reply --as <name> [--thread last|<channel id>:<ts>] "<text>"
```

| Flag | Required | Meaning |
|---|---|---|
| `--as <name>` | yes | Who replies |
| `--thread <ref>` | no, default `last` | A message in the thread: its first message or any reply |

Prints `<name> replied (<channel id>:<ts>)`.

## `channelstack slack react`

```bash
channelstack slack react --as <name> <:emoji:> [--on last|<channel id>:<ts>]
```

| Flag | Required | Meaning |
|---|---|---|
| `--as <name>` | yes | Who reacts |
| `--on <ref>` | no, default `last` | The message |

`:eyes:` and `eyes` are the same reaction. Prints `<name> reacted with <emoji> (<channel id>:<ts>)`.

## `channelstack slack click`

```bash
channelstack slack click --as <name> "<button>"
```

| Flag | Required | Meaning |
|---|---|---|
| `--as <name>` | yes | Who clicks |

Clicks the button with that label in the latest message that has it, in the most recently active conversation. Prints `<name> clicked "<button>"`.

## `channelstack slack stop`

```bash
channelstack slack stop [--as <name>] [--thread last|<channel id>:<ts>]
```

| Flag | Required | Meaning |
|---|---|---|
| `--as <name>` | no | Who presses Stop. Default: the person who started the thread |
| `--thread <ref>` | no, default `last` | A message in the thread |

Fails with `` say who presses Stop with `--as <name>`. `` when the thread was started by the app. Refused with `stop_unavailable` when the app doesn't receive `agent_session_stopped`. Prints `<name> pressed Stop (<channel id>:<ts>)`.

## `channelstack show`

```bash
channelstack show [--thread last|<channel id>:<ts>] [--json]
```

| Flag | Meaning |
|---|---|
| `--thread <ref>` | Only that message's thread. Without it, the whole most recently active conversation, threads included |
| `--json` | The transcript entries as JSON (with their ids, authors, controls), instead of text |

Prints the conversation as a person would read it: edits applied, deletes removed, stream chunks joined.

## `channelstack tail`

```bash
channelstack tail [--once]
```

| Flag | Meaning |
|---|---|
| `--once` | Print what is there and exit, instead of following |

Prints the `dev` session's events as they happen, one line each: `<HH:MM:SS.mmm> <summary>  <outcome>`, with deliveries to the app marked `→` and its API calls `←`. Times are UTC. It reads every 250ms until interrupted.

## `channelstack deliveries`

```bash
channelstack deliveries [<channel>]
```

Prints one line per delivery in the `dev` session, oldest first. `<channel>` is `slack`, `github`, `linear`, `notion`, `resend` or `google`; with one, only that channel's:

```
<id>  <type> <event type or action>  <status>  (attempts: <HTTP status of each attempt, or ->)
```

Without a channel, every channel's deliveries, in the order they were sent, each line starting with its channel (`slack  Ev0A1B2C3D4E  event_callback app_mention  acknowledged  (attempts: 200)`). A channel the server can't list, such as one running live, is left out.

Prints `Nothing was delivered to the agent on <channel> yet.`, or without a channel `Nothing was delivered to the agent yet.`, when there is none. An unknown channel fails with `say which channel: slack, github, linear, notion, resend, google, not "<channel>".`

## `channelstack redeliver`

```bash
channelstack redeliver [<channel>] [last|<delivery>]
```

Delivers it again, the way the platform does: on Slack it is a retry (with `X-Slack-Retry-Num`), on the others a redelivery. `last`, the default, is the newest delivery, of that channel or of any; `<delivery>` is an id that `channelstack deliveries` printed, found in whichever channel has it. Prints `Retried <id> (slack)` or `Redelivered <id> (<channel>)`.

It fails with `nothing was delivered to the agent yet.` (or `… on <channel> yet.`) when there is nothing to send, and with ``no delivery <id>. `channelstack deliveries` lists them.`` (or `no delivery <id> on <channel>. …`) for an id it can't find.

## `channelstack ui`

```bash
channelstack ui [--server <url>]
```

Prints a new one-time link that opens the UI in a browser and signs it in.

## `channelstack mcp`

```bash
channelstack mcp [--server <url>] [--server-file <path>]
```

Serves the attach commands as MCP tools over stdio, for a coding agent that is building the bot. It attaches to the server on the first tool call, so it can start before the server does; a tool call that can't reach the server returns the error, and the next call tries again. Nothing it returns carries the server's token. See [MCP for coding agents](/docs/guide/mcp).

| Tool | Inputs | Same as |
|---|---|---|
| `slack_say` | `as`, `channel`, `text` | `slack say` |
| `slack_reply` | `as`, `text`, `thread?` | `slack reply` |
| `slack_react` | `as`, `emoji`, `on?` | `slack react` |
| `slack_click` | `as`, `label` | `slack click` |
| `slack_stop` | `as?`, `thread?` | `slack stop` |
| `show_thread` | `thread?`, `json?` | `show` |
| `tail` | none | `tail --once`, from where the last call stopped (`Nothing new.` when nothing happened) |
| `list_deliveries` | `channel?` | `deliveries` |
| `redeliver` | `channel?`, `delivery?` (`last`, the default, or an id) | `redeliver` |

`thread` and `on` take `last` (the default) or `<channel id>:<ts>`.

## `channelstack doctor`

```bash
channelstack doctor [--storage-state <path>]…
```

| Flag | Meaning |
|---|---|
| `--storage-state <path>` | A saved browser session to check, besides those in `<home>/browser`. Repeatable |

For each channel: whether it would run fake or live, whether its live credentials work and its allowlist is set; then whether each saved browser session is private (0600) and still signed in. It prints variable names and token prefixes, never a credential.

```
slack
  ok    …
github
  fake  set CHANNELSTACK_GITHUB_APP_ID and CHANNELSTACK_GITHUB_PRIVATE_KEY to run it live
browser sessions
  none saved (the browser actor needs one per person for UI-only actions)
```

Exits `1` when any line is `FAIL`: credentials set in part, an empty allowlist, a credential the platform refuses, a browser session that others can read or that expired.

## `channelstack login`

```bash
channelstack login slack --user <name> [--save <path>]
```

| Flag | Required | Meaning |
|---|---|---|
| `--user <name>` | yes | The sandbox person, e.g. `ana` |
| `--save <path>` | no | Also save the session here, e.g. `.auth/ana-slack.json` for a test that names it |

Opens a browser window at the live workspace's sign-in page. You sign in by hand; channelstack never types or sees a password. Once signed in, it saves the session's cookies to `<home>/browser/slack-<name>.json` (0600), where the browser actor looks for them. Only `slack` is supported.

Prints `Saved <name>'s slack session to <path> (only you can read it).` Waits up to 10 minutes; exits `1` with `Not signed in after 10 minutes: nothing saved.` otherwise.

## `channelstack sweep`

```bash
channelstack sweep [--older-than-hours <n>] [--run <id>] [--check]
```

| Flag | Default | Meaning |
|---|---|---|
| `--older-than-hours <n>` | `24` | Only tagged objects older than this |
| `--run <id>` | all runs | Only what this run made, of any age |
| `--check` | off | Remove nothing; report what is left |

Removes what live runs left behind, in allowlisted workspaces only: what crashed servers' ledgers still list, and objects carrying a run's tag (`channelstack-run-<id>`) that nobody removed. Prints one line per object (`<channel>: removed …`, `left …`, `couldn't remove …`), or `Nothing to remove.` (`Nothing left behind.` with `--check`).

Exits `1` when anything is left.

## `channelstack secrets rotate`

```bash
channelstack secrets rotate
```

Replaces every fake token and signing secret in `<home>/secrets.json`. Restart the server and run `channelstack env` again.

## `channelstack ca rotate`

```bash
channelstack ca rotate
```

Replaces proxy mode's CA in `<home>/ca`. Restart the server; apps keep trusting the new one from the same files. Prints `Replaced proxy mode's CA (<file>). …`.
