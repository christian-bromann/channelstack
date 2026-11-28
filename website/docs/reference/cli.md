---
title: "CLI"
order: 1
description: "Every channelstack command, grouped as `channelstack --help` groups them: what it does, its flags, what it prints, how it fails, and how to get help from the CLI itself."
section: "Tools"
---

# CLI

Every `channelstack` command: what it does, its flags, what it prints and how it fails. The page follows `channelstack --help`: the same groups, in the same order, and each command's `--help` links to its section here. For the workflow around the commands, see [The dev loop](/docs/guide/dev-loop).

```bash
npx channelstack                  # start the server
npx channelstack env >> .env      # point the agent at it
npx channelstack slack say --as ana --in "#support" "@my-agent hi"
npx channelstack show             # read what the agent answered
```

## Commands

**Server**

| Command | Does |
|---|---|
| [`channelstack [start]`](#channelstack-start) | Start the server (the default command) |
| [`channelstack env`](#channelstack-env) | Print `.env` lines that point the agent at the running server |
| [`channelstack ui`](#channelstack-ui) | Print a one-time link that opens the UI |
| [`channelstack mcp`](#channelstack-mcp) | Serve the dev commands as MCP tools, for a coding agent |

**Channels:** act as people. `<channel>` is `slack`, `github`, `linear`, `notion`, `resend`, `google` or `discord`, and every channel has the same commands.

| Command | Does |
|---|---|
| [`channelstack <channel> say`](#channelstack-channel-say) | Say something in a place as a person |
| [`channelstack <channel> reply`](#channelstack-channel-reply) | Reply to an entry as a person |
| [`channelstack <channel> react`](#channelstack-channel-react) | React to an entry with an emoji, where people react |
| [`channelstack <channel> show`](#channelstack-channel-show) | Print a place as a person reads it |
| [`channelstack <channel> actions`](#channelstack-channel-actions) | List the channel's actions with their values |
| [`channelstack <channel> <action>`](#channelstack-channel-action) | Do one of them as a person: click, stop, review, merge, delegate, … |

**Model**

| Command | Does |
|---|---|
| [`channelstack openai respond`](#channelstack-openai-respond) | Script what the fake OpenAI answers the agent's model calls |
| [`channelstack openai calls`](#channelstack-openai-calls) | List the agent's model calls and what the model answered |
| [`channelstack openai undo`](#channelstack-openai-undo) | Remove a script |

**Inspect**

| Command | Does |
|---|---|
| [`channelstack show`](#channelstack-show) | Print the most recently active place on any channel |
| [`channelstack tail`](#channelstack-tail) | Follow deliveries to the agent and its API calls as they happen |
| [`channelstack deliveries`](#channelstack-deliveries) | List what was delivered to the agent |
| [`channelstack redeliver`](#channelstack-redeliver) | Deliver something again, the way the platform does |

**Live mode**

| Command | Does |
|---|---|
| [`channelstack doctor`](#channelstack-doctor) | Check live credentials, allowlists and saved browser sessions |
| [`channelstack login`](#channelstack-login) | Sign a sandbox person in by hand and save the session for the browser actor |
| [`channelstack sweep`](#channelstack-sweep) | Remove what crashed live runs left behind |

**Maintenance**

| Command | Does |
|---|---|
| [`channelstack secrets rotate`](#channelstack-secrets-rotate) | Replace every fake token and signing secret |
| [`channelstack ca rotate`](#channelstack-ca-rotate) | Replace proxy mode's CA |

**Everywhere**

| Flag | Does |
|---|---|
| `-h`, `--help` | Print the command's help: see [Getting help](#getting-help) |
| `-v`, `--version` | Print the version |

## Getting help

The CLI documents itself, one level at a time:

| You type | You get |
|---|---|
| `channelstack --help` | The command groups and the channels, one line each |
| `channelstack slack --help` | Slack's commands and every action its routes generate |
| `channelstack slack click --help` | One action: its values, their types, which are required, which can be given in order |
| `channelstack openai respond --help` | One subcommand: its arguments, flags and examples |
| `channelstack help slack click` | The same as `channelstack slack click --help` |
| `channelstack slack`, `channelstack openai` | A group named alone prints its help |

`--help` wins over everything else on the line: `channelstack slack say --as ana --in "#support" hi --help` prints the help, says nothing and needs no server. Help goes to stdout and exits `0`.

Every help page has the same sections, in this order:

```text
Say something in a channel as a person.            what it does

The channel is made the first time it is named, … more about it

USAGE
  channelstack slack say --as <name> --in <place> <text>

EXAMPLES
  channelstack slack say --as ana --in "#support" "@my-agent hi"

ARGUMENTS
  <text>  What they say

FLAGS                                              VALUES too, for an action
  --as <name>   Who acts, by name. Made the first time the name is used
                (required)
  --in <place>  The channel, by its name, e.g. "#support" (required)

SERVER FLAGS                                       for a command that attaches
  --server <url>        …
  --server-file <path>  …

LEARN MORE
  https://channelstack.dev/docs/reference/cli#channelstack-channel-say
```

A group's help lists its commands instead of `ARGUMENTS` and `FLAGS`. Lines wrap at 80 columns, and a command quoted in a sentence is never split. Headings are bold only on a terminal: never in a pipe, with `NO_COLOR` set or with `TERM=dumb`.

A command takes only the flags its help lists. A mistake is refused with what to do instead:

| Message | Cause |
|---|---|
| ``unknown command "clik" for `channelstack slack`. Did you mean `channelstack slack click`? Run `channelstack slack --help` for its commands.`` | No such command there. The suggestion appears when one is close |
| ``channelstack env takes no --once. Run `channelstack env --help` for its flags.`` | A flag of another command, or none. With a close one: `Did you mean --thread?` |
| ``--as needs a value: --as <name>. Run `channelstack slack say --help`.`` | A flag that takes a value, given without one |
| ``--json is a switch and takes no value. Run `…`.`` | `--json=yes`, say |

## Exit codes

| Code | When |
|---|---|
| `0` | The command did what it says, or printed its help. `start` exits `0` after a clean stop |
| `1` | Anything went wrong: an unknown command, a flag the command doesn't take, no server to attach to, a refusal from the server. The message goes to stderr, prefixed `channelstack: `. `doctor`, `login` and `sweep` also exit `1` when their check fails (see each) |

## Attaching to the running server

`env`, `ui`, `mcp`, every `<channel> …` command, `openai …`, `show`, `tail`, `deliveries` and `redeliver` talk to a running server through its control API. Each takes these flags, listed under `SERVER FLAGS` in its help:

| Flag | Default | Meaning |
|---|---|---|
| `--server <url>` | `CHANNELSTACK_URL` | The server to attach to. With a URL, the token comes from `CHANNELSTACK_TOKEN` |
| `--server-file <path>` | `CHANNELSTACK_SERVER_FILE`, else `<home>/server.json` | Where to read the server's URL and token when no URL is given |

| Message | Cause |
|---|---|
| `` no running server found. Start one with `channelstack start`. `` | No URL given and no server file |
| `CHANNELSTACK_TOKEN is needed to talk to <url>.` | A URL without a token |
| `` the server at <url> isn't reachable. Start one with `channelstack start`. `` | Nothing answers there |
| `the server at <url> doesn't take this token: it may have restarted.` | The server restarted, with a new token |

### The dev session

The attach commands act in one long-lived session named `dev`, which the CLI, the UI and `mcp` share. People and places are made there the first time they are named, with the agent's app in them, and stay until the server stops.

A **place** is what people talk in on the channel:

| Channel | A place is | Named by | Made |
|---|---|---|---|
| `slack` | a channel | its name, `"#support"` | with the person and the app in it; someone in it invites a person who isn't |
| `github` | an issue or a pull request | its title | as an issue in the org's public `dev` repository, which has the app installed; whoever first acts on GitHub is its admin (pushes, labels, merges), the others may do what anyone may on a public repository |
| `linear` | an issue | its title | in a team named Dev |
| `notion` | a page | its title | connected to the integration |
| `resend`, `google` | an email thread | its subject | by the person's email to the agent |
| `discord` | a channel | its name, `"#support"` | private to its participants, with the person and the app in it; the first person who acts on Discord is the guild's admin, and adds a person who isn't in it |

### Naming an entry

An **entry** is one message, comment or email in a place. Where a command takes one (`--to`, `--on`, `--thread`), it is any of these:

| You write | It is |
|---|---|
| `last` (the default) | The newest entry of the channel's most recently active place |
| `<place>:<entry>` | That entry, as `say`, `reply` and `react` print them; `show --json` lists the entries' ids |
| A place's name, `"#support"` | That place's newest entry |

## Server

### `channelstack start`

```bash
channelstack [start] [--no-portless] [--port <n>] [--server-file <path>] [--log-level <level>]
                     [--proxy] [--proxy-port <n>] [--record <dir>]
```

Starts the server. It is the default command: `channelstack` alone starts it too. The server runs in the foreground until `SIGINT` (Ctrl-C), `SIGTERM` or `SIGHUP`, then stops cleanly: live sessions remove what they created, and the server file and portless names are removed. Everything is in memory, so a restart starts fresh.

| Flag | Default | Meaning |
|---|---|---|
| `--no-portless` | off | One loopback port with path prefixes (`http://127.0.0.1:4500/slack`) instead of `*.localhost` names |
| `--port <n>` | `0` with portless (a free port), `4500` without | The loopback port. `0` picks a free one |
| `--server-file <path>` | `CHANNELSTACK_SERVER_FILE`, else `<home>/server.json` | Where to write the control API's URL and token (0600) |
| `--log-level <level>` | `CHANNELSTACK_LOG_LEVEL`, else `info` | `debug`, `info`, `warn`, `error` or `silent`. Logs go to stderr |
| `--proxy` | off | Also run an HTTP proxy for apps with hard-coded hosts: `slack.com`, `api.github.com`, `api.linear.app`, `api.notion.com`, `api.resend.com`, `gmail.googleapis.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `discord.com`, `gateway.discord.gg` and `api.openai.com` go to the fakes, every other host passes through. See [Proxy mode](/docs/guide/proxy-mode) |
| `--proxy-port <n>` | `7464` | The proxy's loopback port. `0` picks a free one. Needs `--proxy` |
| `--record <dir>` | none | Write the shape of every exchange with those hosts, and of every webhook, to `<dir>/shapes.jsonl`: structure only, never a value. Needs `--proxy` |

It reads `CHANNELSTACK_HOME`, `CHANNELSTACK_SEED`, `CHANNELSTACK_<CHANNEL>_WEBHOOK_URL` and the live credentials from the environment ([Environment variables](/docs/reference/environment-variables)).

Prints:

```text
channelstack <version> · in-memory

  Control  https://channelstack.localhost/_channelstack
  echo     https://echo.localhost
  slack    https://slack.localhost
  github   https://github.localhost
  linear   https://linear.localhost
  notion   https://notion.localhost
  resend   https://resend.localhost
  google   https://google.localhost
  discord  https://discord.localhost
  openai   https://openai.localhost
  UI       https://channelstack.localhost/?login=…

  `channelstack env` prints tokens and URLs as .env lines
```

With `--proxy`, a `Proxy` line adds the proxy's URL and the CA file, and the last line points at `channelstack env --proxy`. The UI link signs one browser in, once; `channelstack ui` prints a fresh one. `echo` is channelstack's own minimal test platform. `openai` is the fake OpenAI; the app's base URL is that address with `/v1`, as `channelstack env` prints it.

| Error | Cause |
|---|---|
| `A channelstack server is already running at <url> (pid <n>, from <file>). …` | The server file belongs to a server that answers. Stop it, or pass another `--server-file` |
| `--proxy-port needs --proxy`, `--record needs --proxy` | |
| `--port must be a port number, got "…"` | Also for `--proxy-port` |
| `portless isn't installed. Install it (npm install -g portless) or start with --no-portless.` | |

### `channelstack env`

```bash
channelstack env [--proxy] [--app <name>] [--channel <name>]
```

Prints `KEY=value` lines for the agent, one per line, from the running server, so the URLs match how it was started.

```bash
channelstack env >> .env
channelstack env --app coder --channel slack   # a second agent's Slack app
```

| Flag | Default | Meaning |
|---|---|---|
| `--proxy` | off | For proxy mode: the proxy and the CA the app trusts, instead of the API URLs. Fails with `channelstack env --proxy needs proxy mode: start the server with --proxy` when the server runs without `--proxy` |
| `--app <name>` | `my-agent` | Another app's lines, under the keys the built-in app's are printed with, for a second agent process. Makes the app the first time it is asked for ([Several apps](/docs/guide/several-apps)) |
| `--channel <name>` | every channel | Only that channel's lines: `slack`, `github`, `linear`, `notion`, `resend`, `google`, `discord` or `openai` |

What it prints is listed in [Environment variables](/docs/reference/environment-variables#what-channelstack-env-prints). A channel that runs live prints nothing: the app keeps its own configuration.

### `channelstack ui`

```bash
channelstack ui
```

Prints a new one-time link that opens the UI in a browser and signs it in.

### `channelstack mcp`

```bash
channelstack mcp
```

Serves the attach commands as MCP tools over stdio, for a coding agent that is building the bot. It attaches to the server on the first tool call, so it can start before the server does; a tool call that can't reach the server returns the error, and the next call tries again. Nothing it returns carries the server's token. See [MCP for coding agents](/docs/guide/mcp).

```bash
claude mcp add channelstack -- npx channelstack mcp   # register it in Claude Code
```

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
| `openai_respond` | `text?`, `when?`, `times?`, `tool?`, `args?` | `openai respond` |
| `openai_calls` | none | `openai calls` |

`to`, `on` and `thread` take an entry as in [Naming an entry](#naming-an-entry).

## Channels

Every channel has the same commands: `say`, `reply`, `react`, `show`, `actions`, and its own actions. `channelstack <channel> --help` lists them for that channel. Where the channels differ:

| Channel | `react` | `show --thread` |
|---|---|---|
| `slack` | yes | a thread |
| `github` | yes: `:eyes:`, `eyes` and `+1` alike, as GitHub's reaction names | no threads: the issue or pull request the entry is in |
| `linear` | on comments | a comment's thread |
| `notion` | no | a discussion |
| `resend`, `google` | no | no threads: the email thread the entry is in |
| `discord` | yes: `:eyes:` is the emoji named `eyes` | a thread |

### `channelstack <channel> say`

```bash
channelstack <channel> say --as <name> --in <place> "<text>"
```

A person says something in a place.

```bash
channelstack slack say --as ana --in "#support" "@my-agent hi"
channelstack github say --as mo --in "Login fails" "@my-agent look"
```

| Flag | Default | Meaning |
|---|---|---|
| `--as <name>` | required | Who speaks. Made the first time the name is used; names match case-insensitively |
| `--in <place>` | required | Where, by its name. Made the first time, with the app in it, and the text as the person's first words there (a GitHub issue's or Linear issue's description, the email's text) |

`@name` in the text becomes a real mention. In an email thread that exists, it answers the thread's newest email, to everyone. Prints `<name> said it in <place> (<place>:<entry>)`.

Slack and Discord also have a `say` action, with all its values (Slack's blocks and files, a DM by `to`): `channelstack slack act say --help`.

### `channelstack <channel> reply`

```bash
channelstack <channel> reply --as <name> [--to last|<entry>] "<text>"
```

A person replies to an entry: in its thread where the channel has them (a Slack thread, a Linear comment's, a Notion discussion), otherwise a new comment in the place (GitHub), an answer to that email, or Discord's reply, which quotes the message. A reply on a GitHub diff is the `reply` action: `channelstack github act reply --help`.

| Flag | Default | Meaning |
|---|---|---|
| `--as <name>` | required | Who replies |
| `--to <entry>` | `last` | The entry to answer. `--thread` is the same |

Prints `<name> replied (<place>:<entry>)`.

### `channelstack <channel> react`

```bash
channelstack <channel> react --as <name> <emoji> [--on last|<entry>]
```

A person reacts to an entry with an emoji, on a channel whose people react (see [Channels](#channels)). Elsewhere it fails with `people don't react on Notion.`, and the channel's help doesn't list it.

| Flag | Default | Meaning |
|---|---|---|
| `--as <name>` | required | Who reacts |
| `--on <entry>` | `last` | The entry |

Prints `<name> reacted with <emoji> (<place>:<entry>)`.

### `channelstack <channel> show`

```bash
channelstack <channel> show [--in <place>] [--thread last|<entry>] [--json]
```

Prints a place as a person would read it: edits applied, deletes removed, streamed chunks joined.

| Flag | Default | Meaning |
|---|---|---|
| `--in <place>` | the channel's most recently active place | That place, by its name |
| `--thread <entry>` | the whole place | Only that entry's thread; on a channel without threads, the place the entry is in |
| `--json` | off | The transcript entries as JSON (with their ids, authors, controls), instead of text |

### `channelstack <channel> actions`

```bash
channelstack <channel> actions
```

Lists the channel's actions, one a line, with their values (`?` when optional) and types as the routes have them:

```text
click(button: SlackButtonRef (or its label), message?: SlackMessage, thread?: SlackThread | SlackMessage, channel?: SlackConversation): Click a button, …
```

`channelstack <channel> <action> --help` shows one of them in full.

### `channelstack <channel> <action>`

```bash
channelstack <channel> <action> [<value>…] [--<value> <v>…] [--as <name>] [--in <place>] [--on last|<entry>] [--json]
channelstack <channel> act <action> …
```

A person does one of the channel's actions: every action of the channel's person handle in the SDKs that isn't a read, generated from the routes. Slack has `click`, `select`, `stop`, `runCommand`, `invite`, …; GitHub `review`, `merge`, `label`, `requestReview`, …; Linear `delegate`, `setState`, `prompt`, …; Notion `resolve`, `setProperty`, `mention`, …; email `send`; Discord `startThread`, `runCommand`, `click`, …. `channelstack <channel> --help` lists them all, and `channelstack <channel> <action> --help` shows one action's values.

```bash
channelstack slack click --as ana "Approve"           # the button labelled Approve, in the latest conversation
channelstack slack stop --thread last                 # Stop, pressed by whoever started the thread
channelstack linear delegate --as lu --in "Crash on start"
channelstack github merge --as mo --method squash     # the pull request of the newest entry
```

`act <action>` runs any action by name. It is how to reach an action named like a command, which the command hides: Slack's own `say` with blocks and files, GitHub's `reply` on a diff, email's `reply` to everyone (`all`). The `act` line in `channelstack <channel> --help` names them for that channel.

| Flag | Default | Meaning |
|---|---|---|
| `--<value> <v>` | as the action needs | One of the action's values, by name. The ones the usage shows in order (`<button>`) can also come without a name |
| `--as <name>` | whoever started the target's thread | Who acts |
| `--in <place>` | | The target is this place's newest entry. The place is made the first time, as for `say` |
| `--on <entry>` | `last` | The target is this entry |
| `--json` | off | Print the whole answer as JSON |

**The target** is the entry the action is about. A reference the action needs and isn't given (its message, its issue, its thread, the app) comes from the target, and so does the place itself when the action takes one and no reference was given.

**A value is read as its type:**

| You write | It is read as |
|---|---|
| `3`, `true` | A number or a boolean, for a value of that type |
| `'{"title":"Bug"}'`, `'["bug","p1"]'` | JSON, for an object or a list |
| `Approve` | The value's shorthand, for a value that has one: a Slack button's label, a message's text |
| `ana` | A person, by name |
| `app`, `my-agent` | The agent's app |
| `last`, an id, `<field>:<field>` | A handle: the newest one, or one by its id (several fields for a handle with a composite id) |

Prints `<name> did <action> on <place>:<entry>`, then in parentheses the id of what the action answered when it has one (what it made, or the delivery it sent the agent, as for `click` and `stop`), or with `--json` the whole answer. Refused like the SDK method, with the platform's error code.

## Model

The fake OpenAI answers only what a script tells it to. A model call no script answers gets a 400 (`channelstack_no_script`), so an agent on the fake model needs a script before it can answer. See [OpenAI](/docs/platforms/openai).

### `channelstack openai respond`

```bash
channelstack openai respond ["<text>"] [--when <text>] [--times <n>] [--tool <name> [--args <json>]]
```

Scripts what the model answers the agent's next calls in the `dev` session. Scripts are tried in the order they were added. The text may use `{lastUserText}` (the newest user message of the call) and `{toolResult}` (what the agent sent back from a tool).

```bash
channelstack openai respond "You asked: {lastUserText}"
channelstack openai respond "Paged on-call" --when "page" --times -1
channelstack openai respond --tool page_oncall --args '{"team":"infra"}' "Done: {toolResult}"
```

| Flag | Default | Meaning |
|---|---|---|
| `--when <text>` | every call | Answer only calls whose newest user message has this text |
| `--times <n>` | one per turn | How many calls it answers. `-1` answers every matching call |
| `--tool <name>` | none | The model first calls this tool, and the text answers the call that carries its result. Without a text, the script is the tool call alone |
| `--args <json>` | `{}` | With `--tool`: the tool call's arguments, as JSON |

Prints the script's id and what it answers: `ms_…: the model answers 1 call`, `… every matching call`, `… 2 calls about "deploy"`.

| Error | Cause |
|---|---|
| ``say what the model answers: `channelstack openai respond "…"` `` | Neither a text nor `--tool` |
| `--args is the tool's arguments as JSON, not "…"` | |
| `--times is a whole number, not "…"` | |

### `channelstack openai calls`

```bash
channelstack openai calls
```

Prints the `dev` session's model calls, oldest first, one a line: the call's id, the endpoint (`chat.completions` or `responses`), the model, the newest user message, the status and what the model answered or the error, and the script that answered it:

```text
<id>  chat.completions gpt-5 "what broke?" → 200 "You asked: what broke?" (ms_…)
```

Prints `No model calls yet.` when there are none.

### `channelstack openai undo`

```bash
channelstack openai undo <script>
```

Removes a script by the id `openai respond` printed, and prints `Removed <script>.`. It fails with ``say which script: `channelstack openai undo ms_…` `` without one.

## Inspect

### `channelstack show`

```bash
channelstack show [--thread last|<entry>] [--json]
```

Prints the most recently active place of any channel, as a person would read it. `channelstack <channel> show` prints one channel's ([`channelstack <channel> show`](#channelstack-channel-show)).

| Flag | Default | Meaning |
|---|---|---|
| `--thread <entry>` | the whole place | Only the thread of that entry, `last` being the newest |
| `--json` | off | The transcript entries as JSON (with their ids, authors, controls), instead of text |

It fails with ``nothing has been said yet. Start with `channelstack slack say --as ana --in "#support" "@my-agent hi"`.`` before anyone has said anything.

### `channelstack tail`

```bash
channelstack tail [--once]
```

Prints the `dev` session's events as they happen, one line each: `<HH:MM:SS.mmm> <summary>  <outcome>`, with deliveries to the agent marked `→` and its API calls `←`. Times are UTC. It reads every 250ms until interrupted.

| Flag | Default | Meaning |
|---|---|---|
| `--once` | off | Print what is there and exit, instead of following |

### `channelstack deliveries`

```bash
channelstack deliveries [<channel>]
```

Prints one line per delivery in the `dev` session, oldest first. With `<channel>` (`slack`, `github`, `linear`, `notion`, `resend`, `google` or `discord`), only that channel's:

```text
<id>  <type> <event type or action>  <status>  (attempts: <HTTP status of each attempt, or ->)
```

Without a channel, every channel's deliveries, in the order they were sent, each line starting with its channel (`slack  Ev0A1B2C3D4E  event_callback app_mention  acknowledged  (attempts: 200)`). A channel the server can't list, such as one running live, is left out. `openai` has no deliveries: its calls are under [`channelstack openai calls`](#channelstack-openai-calls).

Prints `Nothing was delivered to the agent on <channel> yet.`, or without a channel `Nothing was delivered to the agent yet.`, when there is none. An unknown channel fails with `say which channel: slack, github, linear, notion, resend, google, discord, not "<channel>".`

### `channelstack redeliver`

```bash
channelstack redeliver [<channel>] [last|<delivery>]
```

Delivers it again, the way the platform does: on Slack it is a retry (with `X-Slack-Retry-Num`), on the others a redelivery. `last`, the default, is the newest delivery, of that channel or of any; `<delivery>` is an id that `channelstack deliveries` printed, found in whichever channel has it. Prints `Retried <id> (slack)` or `Redelivered <id> (<channel>)`.

| Error | Cause |
|---|---|
| `nothing was delivered to the agent yet.` (or `… on <channel> yet.`) | Nothing to send |
| ``no delivery <id>. `channelstack deliveries` lists them.`` (or `no delivery <id> on <channel>. …`) | No delivery with that id |

## Live mode

These read the live credentials from the environment and don't attach to a server. See [Live mode](/docs/guide/live-mode).

### `channelstack doctor`

```bash
channelstack doctor [--storage-state <path>]…
```

For each channel: whether it would run fake or live, whether its live credentials work and its allowlist is set; then whether each saved browser session is private (0600) and still signed in. It prints variable names and token prefixes, never a credential.

| Flag | Default | Meaning |
|---|---|---|
| `--storage-state <path>` | those in `<home>/browser` | Another saved browser session to check. Repeatable |

```text
slack
  ok    …
github
  fake  set CHANNELSTACK_GITHUB_APP_ID and CHANNELSTACK_GITHUB_PRIVATE_KEY to run it live
browser sessions
  none saved (the browser actor needs one per person for UI-only actions)
```

Exits `1` when any line is `FAIL`: credentials set in part, an empty allowlist, a credential the platform refuses, a browser session that others can read or that expired.

### `channelstack login`

```bash
channelstack login <channel> --user <name> [--save <path>]
```

Opens a browser window at the live workspace's sign-in page. You sign in by hand; channelstack never types or sees a password. Once signed in, it saves the session (its cookies) to `<home>/browser/<channel>-<name>.json` (0600), where the browser actor looks for it. `<channel>` is `slack`. Discord has no sign-in: a live person there is a second bot, by its token.

```bash
channelstack login slack --user ana --save .auth/ana-slack.json
```

| Flag | Default | Meaning |
|---|---|---|
| `--user <name>` | required | The sandbox person, e.g. `ana` |
| `--save <path>` | none | Also save the session here, for a test that names it |

Prints `Saved <name>'s slack session to <path> (only you can read it).` It waits up to 10 minutes, and exits `1` with `Not signed in after 10 minutes: nothing saved.` otherwise.

### `channelstack sweep`

```bash
channelstack sweep [--older-than-hours <n>] [--run <id>] [--check]
```

Removes what live runs left behind, in allowlisted workspaces only: what crashed servers' ledgers still list, and objects carrying a run's tag (`channelstack-run-<id>`) that nobody removed. Prints one line per object (`<channel>: removed …`, `left …`, `couldn't remove …`), or `Nothing to remove.` (`Nothing left behind.` with `--check`).

| Flag | Default | Meaning |
|---|---|---|
| `--older-than-hours <n>` | `24` | Only tagged objects older than this |
| `--run <id>` | all runs | Only what this run made, of any age |
| `--check` | off | Remove nothing; report what is left |

Exits `1` when anything is left, so `channelstack sweep --check` suits a nightly job.

## Maintenance

### `channelstack secrets rotate`

```bash
channelstack secrets rotate
```

Replaces every fake token and signing secret in `<home>/secrets.json`. Restart the server and run `channelstack env` again.

### `channelstack ca rotate`

```bash
channelstack ca rotate
```

Replaces proxy mode's CA in `<home>/ca`. Restart the server; apps keep trusting the new one from the same files. Prints `Replaced proxy mode's CA (<file>). …`.
