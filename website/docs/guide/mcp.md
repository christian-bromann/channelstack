---
title: "MCP for coding agents"
order: 9
description: "Give a coding agent the attach CLI as MCP tools, so it can post as a person, read the bot's answer, redeliver and check again while it edits the bot."
---

# MCP for coding agents

`channelstack mcp` serves the [attach CLI](/docs/guide/dev-loop)'s commands as MCP tools over stdio. A coding agent that is building your bot can then try it the way you would by hand: post as a person, read what the bot answered, see what was delivered and called, redeliver, and look again.

## Add it to your coding agent

Most coding agents take an MCP server as a command in a JSON config:

```json title=".mcp.json"
{
  "mcpServers": {
    "channelstack": { "command": "npx", "args": ["channelstack", "mcp"] }
  }
}
```

In Claude Code, `claude mcp add channelstack -- npx channelstack mcp` registers the same server (add `--scope project` to write it to `.mcp.json`). Other agents (Cursor, Codex, Windsurf) take the same `command` and `args` in their own MCP settings file.

The MCP server attaches to the running channelstack server on its first tool call, not when it starts, so the coding agent can launch it before you start the server. It finds the server the way the CLI does: through `server.json`, or `--server <url>` in `args` with `CHANNELSTACK_TOKEN` in its environment. If the server isn't reachable, the tool call returns that as an error and the next call tries again.

The server and the bot still need to run, as for the CLI:

```bash
CHANNELSTACK_SLACK_WEBHOOK_URL=http://localhost:3000/slack/events npx channelstack start
npx channelstack env > .env.local    # then start the bot with it
```

## The tools

Every tool acts in the shared `dev` session, the same one the CLI and the UI use, and prints what the matching CLI command prints.

| Tool | Inputs | Same as |
|---|---|---|
| `slack_say` | `as`, `channel` (e.g. `"#support"`), `text` | `channelstack slack say` |
| `slack_reply` | `as`, `text`, `thread`? | `channelstack slack reply` |
| `slack_react` | `as`, `emoji` (e.g. `":eyes:"`), `on`? | `channelstack slack react` |
| `slack_click` | `as`, `label` (the button's label) | `channelstack slack click` |
| `slack_stop` | `as`?, `thread`? | `channelstack slack stop` |
| `show_thread` | `thread`?, `json`? | `channelstack show` |
| `tail` | none | `channelstack tail`, but each call returns only what happened since the last one (everything, the first time) |
| `list_deliveries` | `channel`?: `slack`, `github`, `linear` or `notion`; every channel's without it | `channelstack deliveries` |
| `redeliver` | `channel`?, `delivery`? (`last`, the default, or an id from `list_deliveries`) | `channelstack redeliver` |

- **`as`** is a person's name, such as `ana`. The person is created the first time the name is used.
- **`channel`** in `slack_say` is created the first time, with the person and the bot in it.
- **`thread`** and **`on`** take `"last"` (the default: the newest message) or `"<channel id>:<ts>"`, as `slack_say` and `slack_reply` print it.
- **`slack_stop`** without `as` is pressed by the person who started the thread.

## The loop

This is what a coding agent does with the tools while it works on the bot:

1. **Act as a person.** `slack_say` with `{ "as": "ana", "channel": "#support", "text": "@my-agent summarize today" }` returns `ana said it in #support (C0A1B2C3D4E:1732451234.000100)`. Follow up with `slack_reply`, `slack_react`, `slack_click` or `slack_stop`.
2. **Read the answer.** `show_thread` returns the latest conversation as a person reads it:

   ```
   ana: @my-agent summarize today
     my-agent: Here's what I found about "summarize today".
   ```

   The bot answers asynchronously. If its reply isn't there yet, call `show_thread` again.
3. **See why.** `tail` returns the events delivered to the bot (`→ slack app_mention  200`) and the API calls it made (`← slack chat.postMessage  200`). A failed delivery, or a call refused with an error code, is usually the bug.
4. **Change the bot, then send the same event again.** `list_deliveries` with `{ "channel": "slack" }` lists each delivery's id, event, outcome and attempts. `redeliver` with that id sends it again, the way Slack retries it, and returns `Retried Ev0A1B2C3D4E (slack)`. A bot that now answers twice doesn't handle retries.
5. **Check again** with `show_thread`.

Once the bot behaves, the agent pins it down in a test ([Writing tests](/docs/guide/writing-tests)), which gets a fresh session and creates its own people.

### Errors

A mistake comes back as the tool's error, in one sentence, the same sentence the CLI prints: an unknown delivery id, a missing `as`, a server that isn't running. The coding agent reads it and tries again; nothing crashes.

## What it never returns

The tools return the same text as `show`, `tail` and `deliveries`. None of it carries the server's bearer token, which stays in `server.json` and in the MCP server's memory. Don't paste the tokens from `.env.local` into the chat either: the coding agent doesn't need them to use the tools.

## The skill

channelstack's repository has a skill for coding agents in [`skills/channelstack/SKILL.md`](https://github.com/christian-bromann/channelstack/blob/main/skills/channelstack/SKILL.md). It tells the agent how to set up the server and the MCP config, runs it through the loop above, and shows the test to write afterwards. Copy it into your coding agent's skills folder, for example `.claude/skills/channelstack/SKILL.md` for Claude Code.

## Slack only

The tools that act as a person are Slack's. `list_deliveries` and `redeliver` take every channel, but nothing acts on GitHub, Linear or Notion in the dev session: drive those from a test.
