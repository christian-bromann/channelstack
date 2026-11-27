---
title: "Environment variables"
order: 2
description: "Every environment variable channelstack reads or prints: the server's settings, the clients', the live credentials and allowlists, and what the app gets."
section: "Tools"
---

# Environment variables

Every variable channelstack reads, and every variable it prints for the app. Each is marked by who reads it: the **server** (`channelstack start`, or a server an SDK starts), a **client** (the CLI's attach commands, the SDKs, the Vitest plugin, pytest), or the **app** (your bot, integration or agent, from what `channelstack env` prints).

```bash title=".env.test"
CHANNELSTACK_SLACK_WEBHOOK_URL=http://localhost:3000/slack/events
CHANNELSTACK_SEED=42
```

An empty variable counts as not set everywhere.

## Server

| Variable | Default | Meaning |
|---|---|---|
| `CHANNELSTACK_HOME` | `~/.channelstack` | The state directory: `server.json`, `secrets.json` (fake tokens and signing secrets, 0600), `ca/` (proxy mode's CA), `browser/` (saved browser sessions), the live ledgers. Clients read it too |
| `CHANNELSTACK_SEED` | random per start | Makes generated ids reproducible. Up to 9 digits is used as the seed; any other string is hashed into one |
| `CHANNELSTACK_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent`. Any other value means `info`. `--log-level` wins |
| `CHANNELSTACK_SERVER_FILE` | `<home>/server.json` | Where `start` writes the control API's URL and token (0600). `--server-file` wins. The attach CLI reads it too |
| `CHANNELSTACK_<CHANNEL>_WEBHOOK_URL` | none | Where the server delivers that channel's events to the app. Read once, when the server starts |
| `CHANNELSTACK_<CHANNEL>_APP_<NAME>_WEBHOOK_URL` | none | Where the server delivers that channel's events to another app, the one a test makes with `createApp({ name })`. Read once, when the server starts |

`<CHANNEL>` is `SLACK`, `GITHUB`, `LINEAR`, `NOTION`, `RESEND`, `GOOGLE` or `DISCORD`: `CHANNELSTACK_SLACK_WEBHOOK_URL`, `CHANNELSTACK_GITHUB_WEBHOOK_URL`, `CHANNELSTACK_LINEAR_WEBHOOK_URL`, `CHANNELSTACK_NOTION_WEBHOOK_URL`, `CHANNELSTACK_RESEND_WEBHOOK_URL`, `CHANNELSTACK_GOOGLE_WEBHOOK_URL`, `CHANNELSTACK_DISCORD_WEBHOOK_URL`. The value is the app's own endpoint for that platform, e.g. `http://localhost:3000/slack/events`. For Google it is the push endpoint: Pub/Sub's pushes go there, and their tokens are for it as their audience. For Discord it is the app's interactions endpoint URL, e.g. `http://localhost:3000/interactions`: slash commands and button presses go there, signed with Ed25519.

`<NAME>` is the app's name in upper case with `-` as `_`: `coder` is `CODER`, `code-reviewer` is `CODE_REVIEWER`, as in `CHANNELSTACK_SLACK_APP_CODER_WEBHOOK_URL`. An app without one receives nothing, unless it opens its own Socket Mode connection. See [Several apps](/docs/guide/several-apps).

An app on Slack's Socket Mode connects out and needs no webhook URL. Without one and without a socket, a Slack interaction is refused with `dispatch_failed`. A Discord bot hears everything else over the Gateway connection it opens itself; without `CHANNELSTACK_DISCORD_WEBHOOK_URL`, its interactions arrive there too, as `INTERACTION_CREATE`. See [Connecting your app](/docs/guide/connecting-your-agent).

## Client

| Variable | Read by | Meaning |
|---|---|---|
| `CHANNELSTACK_URL` | CLI, SDKs, Vitest plugin, pytest | The server to attach to, instead of the one in `server.json`. A trailing slash doesn't matter, to the CLI or the SDKs |
| `CHANNELSTACK_TOKEN` | CLI, SDKs, Vitest plugin, pytest | The control API token for `CHANNELSTACK_URL`. The CLI needs it whenever a URL is given; the SDKs fall back to `server.json`'s token when its URL is the same |
| `CHANNELSTACK_HOME` | CLI, SDKs, Vitest plugin, pytest | Where `server.json` is: `<home>/server.json` |
| `CHANNELSTACK_SERVER_FILE` | CLI | Where the attach commands read the URL and token. The SDKs always read `<home>/server.json` |
| `CHANNELSTACK_SERVER_BIN` | SDKs, Vitest plugin, pytest | The server binary to start in `auto` or `start` mode. TypeScript: default the installed `@channelstack/server-<platform>-<arch>` package. Python and Rust: default `channelstack` on the `PATH` |
| `CHANNELSTACK_VITEST_OPTIONS` | Vitest plugin | Set by the plugin itself: its options as JSON, for its global setup. Don't set it |

### People's live tokens

The SDKs read a person's token from the environment when a test leaves `token` out of `createUser`. With the variable unset, the person is fake. So one test runs fake on every PR, and live where the variables are set.

| Variable | For |
|---|---|
| `CHANNELSTACK_SLACK_USER_<NAME>_TOKEN` | `slack.createUser({ name })`: a user token (`xoxp-…`) from a Slack app for the sandbox's people, not the app's own app |
| `CHANNELSTACK_GITHUB_USER_<LOGIN>_TOKEN` | `github.createUser({ login })`: a machine user's fine-grained PAT |
| `CHANNELSTACK_LINEAR_USER_<NAME>_TOKEN` | `linear.createUser({ name })`: a personal API key |
| `CHANNELSTACK_NOTION_USER_<NAME>_TOKEN` | `notion.createUser({ name })`: a personal access token |
| `CHANNELSTACK_RESEND_USER_<NAME>_TOKEN` | `resend.createUser({ name })`: an API key of the person's own Resend team, with a verified domain their address is on |
| `CHANNELSTACK_GOOGLE_USER_<NAME>_TOKEN` | `google.createUser({ name })`: a refresh token for the person's own Gmail account, from the agent's OAuth client |
| `CHANNELSTACK_DISCORD_USER_<NAME>_TOKEN` | `discord.createUser({ name })`: the bot token of a second application in the sandbox guild, which acts as the person through Discord's API. Discord has no API that acts as a person; what the bot writes carries `author.bot` |

`<NAME>` is the name in upper case with every run of other characters as `_`: `Ana` is `ANA`, `ana-smith` is `ANA_SMITH`, the login `ana-channelstack` is `ANA_CHANNELSTACK`.

## Live mode

Read by the **server**. A channel runs live when every one of its credentials is set; with none set it runs fake. With some set and not all, its operations are refused with `live_misconfigured`, naming what is missing. See [Live mode](/docs/guide/live-mode).

| Channel | Credentials | Allowlist | Also |
|---|---|---|---|
| Slack | `CHANNELSTACK_SLACK_APP_ID`, `CHANNELSTACK_SLACK_BOT_TOKEN` (`xoxb-…`) | `CHANNELSTACK_LIVE_SLACK_TEAMS`: workspace ids (`T…`) | |
| GitHub | `CHANNELSTACK_GITHUB_APP_ID`, `CHANNELSTACK_GITHUB_PRIVATE_KEY` (the App's PEM) | `CHANNELSTACK_LIVE_GITHUB_ORGS`: account logins the App is installed on | |
| Linear | `CHANNELSTACK_LINEAR_APP_TOKEN` (the app's OAuth token) | `CHANNELSTACK_LIVE_LINEAR_WORKSPACES`: organization ids | |
| Notion | `CHANNELSTACK_NOTION_TOKEN` (the integration's token) | `CHANNELSTACK_LIVE_NOTION_WORKSPACES`: workspace ids | `CHANNELSTACK_NOTION_PAGE`, `CHANNELSTACK_NOTION_UNSEEN_PAGE` |
| Resend | `CHANNELSTACK_RESEND_API_KEY` (the agent's team's key, `re_…`) | `CHANNELSTACK_LIVE_RESEND_DOMAINS`: the domains mail may go to. Every recipient is checked before anything is sent | `CHANNELSTACK_RESEND_ADDRESS` |
| Google | `CHANNELSTACK_GOOGLE_CLIENT_ID`, `CHANNELSTACK_GOOGLE_CLIENT_SECRET` (the agent's OAuth client, `GOCSPX-…`), `CHANNELSTACK_GOOGLE_REFRESH_TOKEN` (its mailbox's refresh token, `1//0…`) | `CHANNELSTACK_LIVE_GOOGLE_ADDRESSES`: the addresses mail may go to and come from, the agent's and the people's. Every recipient is checked before anything is sent | |
| Discord | `CHANNELSTACK_DISCORD_BOT_TOKEN` (the agent's real bot token) | `CHANNELSTACK_LIVE_DISCORD_GUILDS`: guild ids. Live Discord runs in the first one the bot is in | |

Allowlists are comma-separated. Live mode acts only where its allowlist names the workspace (for Resend the domain, for Google the address, for Discord the guild); anywhere else is refused with `live_not_allowlisted`, and an empty allowlist means live mode acts nowhere.

| Variable | Default | Meaning |
|---|---|---|
| `CHANNELSTACK_REALITY` | unset | `fake`: every channel runs fake, credentials or not. `live`: nothing may fall back to fake; a person without a token is refused with `live_misconfigured`. Any other value is an error |
| `CHANNELSTACK_RUN_ID` | random (10 characters) | The run's id, in the tag every live object carries (`channelstack-run-<id>`) and for `channelstack sweep --run`. 1 to 24 letters and digits, lowercased; 7 or more digits in a row are written in base 36 (Linear refuses names that look like phone numbers). CI sets it to the job's |
| `CHANNELSTACK_NOTION_PAGE` | the only top-level page the integration sees | The page live Notion tests create their pages under. Needed when the integration sees more than one |
| `CHANNELSTACK_NOTION_UNSEEN_PAGE` | none | A page the people can write in and the integration isn't connected to, for tests that create a page the integration can't see |
| `CHANNELSTACK_RESEND_ADDRESS` | `my-agent@` the team's first verified domain | Where people email the agent live: an address on its team's receiving domain |

channelstack's own nightly live run also reads `CHANNELSTACK_DISCORD_PUBLIC_KEY` (the real application's public key, which its reference agent checks interactions with) and `CHANNELSTACK_DISCORD_RELAY_URL` (the smee.io channel the application's interactions endpoint points at, relayed to the reference agent). The server doesn't read them: your own agent has its own configuration live.

Live credentials stay in the server's memory. They are never logged, never returned by the control API, and `channelstack env` prints nothing for a live channel.

> [!WARNING]
> Use sandbox workspaces only. A token in these variables acts as a real app or person on the real platform.

## What `channelstack env` prints

Read by the **app**. `channelstack env` (and the `channelstack.env()` fixture) prints the fake channels' settings as `KEY=value` lines. The values come from the running server: the URLs follow how it was started (portless names, or `--no-portless` paths), and the secrets are this install's, from `<home>/secrets.json`.

| Variable | Channel | Value |
|---|---|---|
| `SLACK_API_URL` | Slack | The Web API base, e.g. `https://slack.localhost/api/` |
| `SLACK_BOT_TOKEN` | Slack | `xoxb-…` |
| `SLACK_APP_TOKEN` | Slack | `xapp-…`, for Socket Mode |
| `SLACK_SIGNING_SECRET` | Slack | |
| `GITHUB_API_URL` | GitHub | E.g. `https://github.localhost` |
| `GITHUB_APP_ID` | GitHub | |
| `GITHUB_APP_SLUG` | GitHub | |
| `GITHUB_INSTALLATION_ID` | GitHub | |
| `GITHUB_BOT_USER_ID` | GitHub | |
| `GITHUB_PRIVATE_KEY` | GitHub | The App's PEM on one line, with `\n` for its line breaks |
| `GITHUB_WEBHOOK_SECRET` | GitHub | |
| `LINEAR_API_URL` | Linear | The GraphQL endpoint, e.g. `https://linear.localhost/graphql` |
| `LINEAR_ACCESS_TOKEN` | Linear | The app's OAuth token |
| `LINEAR_WEBHOOK_SECRET` | Linear | |
| `LINEAR_CLIENT_ID` | Linear | |
| `LINEAR_CLIENT_SECRET` | Linear | |
| `NOTION_BASE_URL` | Notion | E.g. `https://notion.localhost` |
| `NOTION_TOKEN` | Notion | The integration's token |
| `NOTION_VERIFICATION_TOKEN` | Notion | What webhook deliveries are signed with |
| `RESEND_BASE_URL` | Resend | E.g. `https://resend.localhost`. The `resend` SDK reads it itself |
| `RESEND_API_KEY` | Resend | The agent's team's key (`re_…`) |
| `RESEND_WEBHOOK_SECRET` | Resend | What webhook deliveries are signed with (`whsec_…`) |
| `RESEND_FROM` | Resend | The address the agent sends from, with its name: `my-agent <my-agent@acme.example>` |
| `GOOGLE_API_URL` | Google | The root to give `googleapis` as `rootUrl`, per API: e.g. `https://google.localhost/` |
| `GOOGLE_TOKEN_URL` | Google | Google's token endpoint, for `OAuth2Client`'s `endpoints.oauth2TokenUrl` |
| `GOOGLE_CERTS_URL` | Google | The certificates push tokens are signed against, for `endpoints.oauth2FederatedSignonPemCertsUrl` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google | The agent's OAuth client (`…apps.googleusercontent.com`, `GOCSPX-…`) |
| `GOOGLE_REFRESH_TOKEN` | Google | The agent's mailbox's refresh token (`1//0…`): the token endpoint takes the `refresh_token` grant only |
| `GMAIL_ADDRESS` | Google | The agent's mailbox: `my-agent@acme.example` |
| `GOOGLE_PUBSUB_TOPIC` | Google | The topic to give `users.watch`: the only one the fake publishes to |
| `GOOGLE_PUSH_SERVICE_ACCOUNT` | Google | Who pushes: the `email` claim of every push token |
| `GOOGLE_PUSH_AUDIENCE` | Google | The `aud` of every push token: the push endpoint, `CHANNELSTACK_GOOGLE_WEBHOOK_URL` (for another app, its own variable). Printed when that is set |
| `DISCORD_API_URL` | Discord | The REST base to give discord.js as `rest.api`, e.g. `https://discord.localhost/api`. discord.js adds `/v10` and finds the Gateway from `GET /gateway/bot` |
| `DISCORD_TOKEN` | Discord | The bot's token, for `client.login` |
| `DISCORD_APPLICATION_ID` | Discord | The application's id, the bot's too: for registering commands |
| `DISCORD_PUBLIC_KEY` | Discord | The application's Ed25519 public key (hex), which interactions over HTTP are checked against with `verifyKey` |
| `DISCORD_GUILD_ID` | Discord | The guild the bot is in: for registering guild commands |
| `ECHO_API_URL`, `ECHO_APP_TOKEN`, `ECHO_SIGNING_SECRET` | Echo | channelstack's own test platform. Ignore them |

The names are the ones the platforms' SDKs and examples use; map them to your app's own if they differ. `channelstack secrets rotate` changes every secret; run `channelstack env` again after a restart.

### `channelstack env --app` and `--channel`

`channelstack env --app coder` (and `channelstack.env({ app: "coder" })`) prints another app's lines under the same keys: `SLACK_BOT_TOKEN` is `coder`'s bot token, `GITHUB_APP_ID` its App's id, `RESEND_FROM` `coder <coder@coder.acme.example>`, `GMAIL_ADDRESS` `coder@acme.example`, and so on. A second agent process starts from an `.env` of the same shape as the first. Asking makes the app, with the channel's default settings, if no test has made it yet, so the agent can start before the tests; without `--channel`, on every channel. `--app my-agent` is the same as no `--app`. A name that isn't an app's (1 to 32 lower-case letters, digits and hyphens, starting with a letter) is refused with `invalid_argument`.

`--channel slack` prints that channel's lines only, which is what a second agent on one channel needs: `channelstack env --app coder --channel slack`. A channel that doesn't exist is `not_found`.

### `channelstack env --proxy`

For an app that hard-codes the platforms' hosts. The server must run with `--proxy`. It prints the same lines without the API URLs (the app keeps `slack.com` and the others), plus:

| Variable | Value |
|---|---|
| `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy`, `http_proxy` | `http://127.0.0.1:<proxy port>` (default port `7464`) |
| `NO_PROXY`, `no_proxy` | `localhost,127.0.0.1,::1,.localhost` |
| `NODE_USE_ENV_PROXY` | `1`: Node 24 routes its own `http`, `https` and `fetch` through the proxy only with it |
| `NODE_OPTIONS` | `--import="<home>/proxy/node-env-proxy.mjs"`: keeps Node's proxy-aware `fetch` in an app that loads undici 7 or later |
| `NODE_EXTRA_CA_CERTS` | `<home>/ca/ca.pem`: channelstack's CA alone |
| `SSL_CERT_FILE` | `<home>/ca/bundle.pem`: the public roots plus the CA, for runtimes that replace their bundle |
| `REQUESTS_CA_BUNDLE` | `<home>/ca/bundle.pem`, for Python's `requests` |

The CA is trusted only by the app that gets these variables. See [Proxy mode](/docs/guide/proxy-mode).
