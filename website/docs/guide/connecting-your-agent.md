---
title: "Connecting your agent"
order: 2
description: "Start the server, give your agent the env from channelstack env, point each SDK at the fakes and tell the server where the agent listens."
---

# Connecting your agent

This page gets your agent talking to the fakes: start the server, give the agent its environment, point its SDK at channelstack, and tell the server where to deliver events. Your agent's code doesn't change beyond a base-URL option its SDK already has.

## Start the server

```bash
npm i -D channelstack
npm i -g portless
npx channelstack
```

```
channelstack 0.1.0 · in-memory

  Control  https://channelstack.localhost/_channelstack
  echo     https://echo.localhost
  slack    https://slack.localhost
  github   https://github.localhost
  linear   https://linear.localhost
  notion   https://notion.localhost
  UI       https://channelstack.localhost/?login=…

  `channelstack env` prints tokens and URLs as .env lines
```

`npx channelstack` is short for `npx channelstack start`. It registers the `*.localhost` names with [portless](https://github.com/vercel-labs/portless), which serves them over HTTPS. The UI line is a one-time link that signs one browser in; `channelstack ui` prints a fresh one. `echo` is an internal driver channelstack uses to test itself; you can ignore it.

The server keeps everything in memory. Stop it with Ctrl+C, and the next start begins with an empty world.

### Without portless

If portless isn't installed, the server stops with `portless isn't installed. Install it (npm install -g portless) or start with --no-portless.` Without portless, everything is served over plain HTTP on one loopback port, with a path prefix per fake:

```bash
npx channelstack start --no-portless --port 4500
```

The fakes are then at `http://127.0.0.1:4500/slack`, `/github`, `/linear` and `/notion`, and `channelstack env` prints those URLs instead. `--port` defaults to 4500 without portless; `--port 0` picks a free port. Plain HTTP on loopback needs no certificate, so this is also the simplest way around [TLS trust](#tls-trust-per-runtime) problems.

## Give the agent its environment

`channelstack env` asks the running server for the lines your agent needs and prints them in `.env` format:

```bash
npx channelstack env >> .env.local
```

```ini title=".env.local"
SLACK_API_URL=https://slack.localhost/api/
SLACK_BOT_TOKEN=xoxb-…
SLACK_APP_TOKEN=xapp-…
SLACK_SIGNING_SECRET=…
GITHUB_API_URL=https://github.localhost
GITHUB_APP_ID=…
…
```

What it prints, per platform:

| Platform | Variables |
|---|---|
| Slack | `SLACK_API_URL` (ends in `/api/`), `SLACK_BOT_TOKEN` (`xoxb-…`), `SLACK_APP_TOKEN` (`xapp-…`, for Socket Mode), `SLACK_SIGNING_SECRET` |
| GitHub | `GITHUB_API_URL`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG` (`my-agent`), `GITHUB_INSTALLATION_ID`, `GITHUB_BOT_USER_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` |
| Linear | `LINEAR_API_URL` (ends in `/graphql`), `LINEAR_ACCESS_TOKEN` (`lin_oauth_…`), `LINEAR_WEBHOOK_SECRET`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` |
| Notion | `NOTION_BASE_URL`, `NOTION_TOKEN` (`ntn_…`), `NOTION_VERIFICATION_TOKEN` |

It also prints three `ECHO_*` lines for the internal driver. A platform that runs [live](/docs/guide/live-mode) prints nothing: there, the agent uses its own real configuration.

`GITHUB_PRIVATE_KEY` is a PEM on one line, with `\n` for its line breaks, because an `.env` line is one line. Turn it back into a PEM in your agent: `GITHUB_PRIVATE_KEY.replaceAll("\\n", "\n")`. Probot, Octokit's App auth and most deploy targets take the key this way.

Write the agent so it uses an API URL only when the variable is set. Then the same code talks to the fake in tests and to the real platform in production.

## Point each SDK at the fake

Every platform SDK already has a base-URL option. These are the ones the [reference agents](https://github.com/christian-bromann/channelstack/tree/main/examples/agents) use:

| SDK | Option | Variable |
|---|---|---|
| Bolt for JavaScript | `clientOptions: { slackApiUrl }` | `SLACK_API_URL` |
| Bolt for Python, `slack_sdk` | `WebClient(base_url=…)` | `SLACK_API_URL` |
| Octokit, `@octokit/rest` | `baseUrl` | `GITHUB_API_URL` |
| Probot | `baseUrl` in `Probot.defaults(…)` | `GITHUB_API_URL` |
| `@linear/sdk` | `apiUrl` | `LINEAR_API_URL` |
| `@notionhq/client` | `baseUrl` | `NOTION_BASE_URL` |
| Chat SDK adapters (`@chat-adapter/slack`, `/github`, `/linear`) | `apiUrl`, or read from the environment | `SLACK_API_URL`, `GITHUB_API_URL`, `LINEAR_API_URL` |

### Slack with Bolt

```ts title="agent.ts"
import { App } from "@slack/bolt";

const { SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_API_URL } = process.env;

const app = new App({
  token: SLACK_BOT_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  ...(SLACK_API_URL ? { clientOptions: { slackApiUrl: SLACK_API_URL } } : {}),
});

await app.start(3000);
```

In Python, give Bolt a `WebClient` with the base URL:

```python title="app.py"
import os

from slack_bolt import App
from slack_sdk import WebClient

client = WebClient(
    token=os.environ["SLACK_BOT_TOKEN"],
    base_url=os.environ.get("SLACK_API_URL", "https://slack.com/api/"),
)
app = App(client=client, signing_secret=os.environ["SLACK_SIGNING_SECRET"])
```

### GitHub with Octokit or Probot

```ts title="agent.ts"
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

const { GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_API_URL } = process.env;
const privateKey = GITHUB_PRIVATE_KEY!.replaceAll("\\n", "\n");

const octokit = (installationId: number) =>
  new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: GITHUB_APP_ID, privateKey, installationId },
    ...(GITHUB_API_URL ? { baseUrl: GITHUB_API_URL } : {}),
  });
```

With Probot, pass the same values to `Probot.defaults`:

```ts title="server.ts"
import { Probot, Server } from "probot";

const { GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, GITHUB_API_URL } = process.env;

const server = new Server({
  Probot: Probot.defaults({
    appId: GITHUB_APP_ID,
    privateKey: GITHUB_PRIVATE_KEY!.replaceAll("\\n", "\n"),
    secret: GITHUB_WEBHOOK_SECRET,
    ...(GITHUB_API_URL ? { baseUrl: GITHUB_API_URL } : {}),
  }),
  port: 3000,
  webhookPath: "/api/github/webhooks",
});
```

The fake serves the API both at the root (like `api.github.com`) and at `/api/v3` (like GitHub Enterprise), because some SDKs assume the Enterprise layout once a host is set.

### Linear and Notion

```ts title="agent.ts"
import { LinearClient } from "@linear/sdk";
import notionClient from "@notionhq/client";

// @notionhq/client is CommonJS: Node gives it to an ES module as its default export.
const { Client } = notionClient;
const { LINEAR_ACCESS_TOKEN, LINEAR_API_URL, NOTION_TOKEN, NOTION_BASE_URL } = process.env;

const linear = new LinearClient({
  accessToken: LINEAR_ACCESS_TOKEN,
  ...(LINEAR_API_URL ? { apiUrl: LINEAR_API_URL } : {}),
});

const notion = new Client({
  auth: NOTION_TOKEN,
  ...(NOTION_BASE_URL ? { baseUrl: NOTION_BASE_URL } : {}),
});
```

Verify incoming webhooks with the secrets `channelstack env` printed: `LINEAR_WEBHOOK_SECRET` (for `LinearWebhookClient` or your own check of `Linear-Signature`), and `NOTION_VERIFICATION_TOKEN` (for `verifyWebhookSignature` and `X-Notion-Signature`).

### Chat SDK

The Chat SDK's Slack, GitHub and Linear adapters read `SLACK_API_URL`, `GITHUB_API_URL` and `LINEAR_API_URL` from the environment on their own, or take an `apiUrl` option. With the lines from `channelstack env` in the agent's environment, an agent on the Chat SDK needs no change at all.

## Tell the server where the agent listens

The server delivers each platform's events to one URL, which it reads from `CHANNELSTACK_<CHANNEL>_WEBHOOK_URL` when it starts:

```bash
CHANNELSTACK_SLACK_WEBHOOK_URL=http://localhost:3000/slack/events \
CHANNELSTACK_GITHUB_WEBHOOK_URL=http://localhost:3001/api/github/webhooks \
CHANNELSTACK_LINEAR_WEBHOOK_URL=http://localhost:3002/webhooks/linear \
CHANNELSTACK_NOTION_WEBHOOK_URL=http://localhost:3003/webhooks/notion \
npx channelstack
```

| Variable | What arrives there |
|---|---|
| `CHANNELSTACK_SLACK_WEBHOOK_URL` | Events API requests, interactivity (`block_actions`, `view_submission`, `view_closed`), shortcuts and slash commands. Bolt handles all of them at `/slack/events` |
| `CHANNELSTACK_GITHUB_WEBHOOK_URL` | App webhooks, signed with `X-Hub-Signature-256` |
| `CHANNELSTACK_LINEAR_WEBHOOK_URL` | Webhooks and `AgentSessionEvent`s, signed with `Linear-Signature` |
| `CHANNELSTACK_NOTION_WEBHOOK_URL` | Integration webhooks, signed with `X-Notion-Signature` |

Set only the ones your agent uses. Any URL the server can reach works; a loopback URL is the simplest. The server reads these variables once, at start, so restart it to change one.

Without a URL (and, for Slack, without a Socket Mode connection), a fake sends nothing. People can still act, but nothing reaches the agent, and `msg.delivery` is `undefined`. If a test sees no reply at all, check this first.

## Slack in Socket Mode

An agent in Socket Mode connects out to Slack over a WebSocket and needs no URL at all. Leave `CHANNELSTACK_SLACK_WEBHOOK_URL` unset and give the agent the app token:

```ts title="agent.ts"
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  ...(process.env.SLACK_API_URL ? { clientOptions: { slackApiUrl: process.env.SLACK_API_URL } } : {}),
});

await app.start();
```

The agent calls `apps.connections.open` with its `xapp-…` token, as it does against Slack, and the fake answers with a WebSocket URL of its own (`wss://slack.localhost/link?…`). Events, interactivity and slash commands then arrive over that connection, wrapped in Socket Mode envelopes that the agent acknowledges.

A few things differ from HTTP delivery, as they do on Slack:

- There is no signature to check: the connection is the app's own. The standard `slack.bad-signature` check passes without sending anything.
- A retry carries `retry_attempt` and `retry_reason` in the envelope instead of headers.
- `slack.socketConnections` tells a test how many connections the agent has open, and `slack.fault({ type: "drop_socket" })` drops them to test reconnecting. See [delivery and failures](/docs/guide/delivery-and-failures#faults).

## TLS trust per runtime

With portless, the fakes are served over HTTPS with a certificate from portless's local CA. `portless trust` adds that CA to the system trust store, but not every runtime reads the system store. If your agent fails with a certificate error, set what its runtime needs:

| Runtime | What to set in the agent's environment |
|---|---|
| Node 24 and later | `NODE_USE_SYSTEM_CA=1`, so Node reads the system store |
| Python with certifi (`requests`, `httpx`, `slack_sdk`) | `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE`, pointing at a bundle of certifi's roots plus portless's CA |
| Go | Nothing on macOS (Go reads the keychain); `SSL_CERT_FILE` on Linux |
| Anything else | Start the server with `--no-portless` and use plain HTTP on loopback |

In base-URL mode, `channelstack env` doesn't print these: set them yourself. `portless doctor` checks portless's own setup. [Proxy mode](/docs/guide/proxy-mode) is different: there, `channelstack env --proxy` prints the CA settings for channelstack's own proxy CA.

## Secrets

The fake tokens and signing secrets are random. The server generates them once per install and keeps them in `~/.channelstack/secrets.json` (mode 0600), or under `CHANNELSTACK_HOME` if you set it. They stay the same across restarts, so the `.env.local` you wrote once keeps working.

To replace them all:

```bash
npx channelstack secrets rotate
```

Then restart the server and run `channelstack env` again, because the agent's copy is now stale.

None of these values works anywhere but on your channelstack server. Still, keep `.env.local` out of version control, like any `.env` file. The control API's own bearer token is a separate secret in `~/.channelstack/server.json`; `channelstack env` never prints it, so it never ends up in the agent's environment.

## Check the connection

With the server and the agent running, post as a person and read what came back:

```bash
npx channelstack slack say --as ana --in "#support" "@my-agent hi"
npx channelstack show
npx channelstack deliveries slack
```

`show` prints the latest conversation as a person would read it, and `deliveries` lists what the server sent the agent and how the agent answered each attempt. If the agent answered, you're connected: go on to [writing tests](/docs/guide/writing-tests). If not, [the dev loop](/docs/guide/dev-loop) and [troubleshooting](/docs/guide/troubleshooting) cover what to look at.
