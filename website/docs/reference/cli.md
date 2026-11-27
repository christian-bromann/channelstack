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
| [`channelstack <channel> say`](#channelstack-channel-say) | Say something in a place as a person |
| [`channelstack <channel> reply`](#channelstack-channel-reply) | Reply to an entry as a person |
| [`channelstack <channel> react`](#channelstack-channel-react) | React to an entry as a person |
| [`channelstack <channel> show`](#channelstack-show) | Print a place as a person reads it |
| [`channelstack <channel> actions`](#channelstack-channel-actions) | List what else the channel's people do |
| [`channelstack <channel> <action>`](#channelstack-channel-action) | Do one of those as a person: click, stop, review, delegate, … |
| [`channelstack show`](#channelstack-show) | Print the most recently active place on any channel |
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

`<channel>` is `slack`, `github`, `linear`, `notion`, `resend` or `google`: every channel has the same commands.

## Exit codes

| Code | When |
|---|---|
| `0` | The command did what it says. `start` exits `0` after a clean stop |
| `1` | Anything went wrong: a bad flag, no server to attach to, a refusal from the server, an unknown command. The message goes to stderr, prefixed `channelstack: `. `doctor`, `login` and `sweep` also exit `1` when their check fails (see each) |

## Attaching to the running server

`env`, `<channel> …`, `show`, `tail`, `deliveries`, `redeliver`, `ui` and `mcp` talk to a running server through its control API.

| Flag | Default | Meaning |
|---|---|---|
| `--server <url>` | `CHANNELSTACK_URL` | The server to attach to. With an explicit URL, the token comes from `CHANNELSTACK_TOKEN` |
| `--server-file <path>` | `CHANNELSTACK_SERVER_FILE`, else `<home>/server.json` | Where to read the server's URL and token when no URL is given |

| Message | Cause |
|---|---|
| `` no running server found. Start one with `channelstack start`. `` | No URL given and no server file |
| `CHANNELSTACK_TOKEN is needed to talk to <url>.` | A URL without a token |
| `` the server at <url> isn't reachable. Start one with `channelstack start`. `` | Nothing answers there |

The attach commands act in one long-lived session named `dev`, which the CLI, the UI and `mcp` share. People and places are created there on first use, by name, with the app in them. A place is what people talk in on the channel:

| Channel | A place is | Named by | Made |
|---|---|---|---|
| `slack` | a channel | its name, `"#support"` | with the person and the app in it; someone in it invites a person who isn't |
| `github` | an issue or a pull request | its title | as an issue in the org's public `dev` repository, which has the app installed; whoever first acts on GitHub is its admin (pushes, labels, merges), the others may do what anyone may on a public repository |
| `linear` | an issue | its title | in a team named Dev |
| `notion` | a page | its title | connected to the integration |
| `resend`, `google` | an email thread | its subject | by the person's email to the agent |

Where a command takes an entry (a message, a comment, an email), `last` means the newest entry of the channel's most recently active place in the `dev` session. Any entry can be named `<place>:<entry>`, as `say` and `reply` print them and `show --json` lists the entries' ids, and a place by its name stands for its newest entry.

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
channelstack env [--proxy] [--app <name>] [--channel <name>] [--server <url>]
```

Prints `KEY=value` lines for the app, one per line, from the running server, so the URLs match how it was started.

| Flag | Meaning |
|---|---|
| `--proxy` | For proxy mode: the proxy and the CA the app trusts, instead of the API URLs. Fails with `channelstack env --proxy needs proxy mode: start the server with --proxy` when the server runs without `--proxy` |
| `--app <name>` | Another app's lines, under the keys the built-in app's are printed with, for a second agent process. Makes the app the first time it is asked for ([Several apps](/docs/guide/several-apps)) |
| `--channel <name>` | Only that channel's lines: `slack`, `github`, `linear`, `notion`, `resend` or `google` |

What it prints is listed in [Environment variables](/docs/reference/environment-variables#what-channelstack-env-prints). A channel that runs live prints nothing: the app keeps its own configuration.

## `channelstack <channel> say`

```bash
channelstack <channel> say --as <name> --in <place> "<text>"
```

| Flag | Required | Meaning |
|---|---|---|
| `--as <name>` | yes | Who speaks. Created the first time the name is used; names match case-insensitively |
| `--in <place>` | yes | Where, by its name. Made the first time, with the app in it, and the text as the person's first words there (a GitHub issue's or Linear issue's description, the email's text) |

`@name` in the text becomes a real mention. In an email thread that exists, it answers the thread's newest email, to everyone. Prints `<name> said it in <place> (<place>:<entry>)`.

## `channelstack <channel> reply`

```bash
channelstack <channel> reply --as <name> [--to last|<ref>] "<text>"
```

| Flag | Required | Meaning |
|---|---|---|
| `--as <name>` | yes | Who replies |
| `--to <ref>`, `--thread <ref>` | no, default `last` | The entry to answer |

In its thread where the channel has them (a Slack thread, a Linear comment's, a Notion discussion), otherwise a new comment in the place (GitHub), or an answer to that email. A reply on a GitHub diff is the `reply` action. Prints `<name> replied (<place>:<entry>)`.

## `channelstack <channel> react`

```bash
channelstack <channel> react --as <name> <emoji> [--on last|<ref>]
```

| Flag | Required | Meaning |
|---|---|---|
| `--as <name>` | yes | Who reacts |
| `--on <ref>` | no, default `last` | The entry |

On Slack, GitHub (`:eyes:`, `eyes` and `+1` alike, as GitHub's reaction names) and Linear (comments only). Notion and email have no reactions: `` people don't react on Notion. ``. Prints `<name> reacted with <emoji> (<place>:<entry>)`.

## `channelstack <channel> actions`

Lists what else the channel's people do, one action per line with its values (`?` when optional), as the routes have them: `click(button: SlackButtonRef (or its label), message?: SlackMessage, thread?: SlackThread | SlackMessage, channel?: SlackConversation): …`.

## `channelstack <channel> <action>`

```bash
channelstack <channel> <action> [--as <name>] [--in <place>] [--on last|<ref>] [<value>…] [--<value name> <value>…]
channelstack <channel> act <action> …
```

| Flag | Required | Meaning |
|---|---|---|
| `--as <name>` | no | Who acts. Default: the person who started the target's thread |
| `--in <place>` | no | The target is the newest entry of this place (made the first time, as for `say`) |
| `--on <ref>` | no | The target is this entry. Without `--in` and `--on`, it is `last` |
| `--<value name> <value>` | as the action needs | A value by name; the first values can also come in order, without names |

The actions are generated from the routes: every action of the channel's person handle in the SDKs that isn't a read, such as `click`, `stop`, `select`, `invite` on Slack, `review`, `merge`, `label`, `requestReview` on GitHub, `delegate`, `setState`, `prompt` on Linear, `resolve`, `setProperty`, `mention` on Notion, `send` on email. A value is read as its type: a number, `true` or `false`, JSON for an object or a list, and a value with a shorthand as that text (a Slack button's label). A person is named, the agent's app is `app` or its name, and a handle is `last` or an id (`<field>:<field>` for one with several). A reference the action needs and isn't given comes from the target (its message, its issue, its thread, the app), and so does the place itself when the action takes it and no reference was given. `act <action>` is for an action named like a command (Slack's own `say`, with its blocks and files).

```bash
channelstack slack click --as ana "Approve"          # the button labelled Approve, in the latest conversation
channelstack slack stop --thread last                # Stop, pressed by whoever started the thread
channelstack linear delegate --as lu --in "Crash on start"
channelstack github merge --as mo --method squash     # the pull request of the newest entry (`last`)
```

Prints `<name> did <action> on <place>:<entry>`, then in parentheses the id of what the action answered when it has one (what it made, or the delivery it sent the agent, as for `click` and `stop`), or with `--json` the whole answer. Refused like the SDK method, with the platform's error code.

## `channelstack show`

```bash
channelstack show [--thread last|<ref>] [--json]
channelstack <channel> show [--in <place>] [--thread last|<ref>] [--json]
```

| Flag | Meaning |
|---|---|
| `--in <place>` | That place. Without it, the most recently active one: of the channel, or of any channel without one |
| `--thread <ref>` | Only that entry's thread (a Slack thread, a Linear comment's, a Notion discussion). Without it, the whole place, threads included |
| `--json` | The transcript entries as JSON (with their ids, authors, controls), instead of text |

Prints the place as a person would read it: edits applied, deletes removed, stream chunks joined.

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
| `say` | `channel`, `as`, `in`, `text` | `<channel> say` |
| `reply` | `channel`, `as`, `text`, `to?` | `<channel> reply` |
| `react` | `channel`, `as`, `emoji`, `on?` | `<channel> react` |
| `show` | `channel?`, `in?`, `thread?`, `json?` | `<channel> show`; without `channel`, `show` |
| `<channel>_act` | `action`, `params?`, `as?`, `in?`, `on?` | `<channel> <action>`, with the values by name in `params` |
| `tail` | none | `tail --once`, from where the last call stopped (`Nothing new.` when nothing happened) |
| `list_deliveries` | `channel?` | `deliveries` |
| `redeliver` | `channel?`, `delivery?` (`last`, the default, or an id) | `redeliver` |

`to`, `on` and `thread` take `last` (the default), `<place>:<entry>`, or a place by name.

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
