# Changelog

All notable changes to channelstack. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

## [0.2.0] - 2026-11-28

### The fakes

- **Slack:**
  - A DM can't gain or lose a person, as on Slack ([#119](https://github.com/christian-bromann/channelstack/pull/119))
- **GitHub:**
  - A transcript entry keeps its own time, so a label or a close doesn't make it newer ([#118](https://github.com/christian-bromann/channelstack/pull/118))

### Tools

- **The server:**
  - **Breaking:** The dev tools act on every channel, with each channel's actions generated from its routes ([#106](https://github.com/christian-bromann/channelstack/pull/106))
  - Phase 11, Discord: a bot in a guild, on the Gateway and HTTP interactions ([#103](https://github.com/christian-bromann/channelstack/pull/103))
  - Phase 12, any number of agent apps per channel ([#107](https://github.com/christian-bromann/channelstack/pull/107))
  - Phase 13, a fake OpenAI scripted per test ([#116](https://github.com/christian-bromann/channelstack/pull/116))
  - Phase 14, the fake OpenAI's images, audio, files and built-in tools ([#121](https://github.com/christian-bromann/channelstack/pull/121))
  - **Breaking:** Help for every command, and each command takes only its own flags ([#128](https://github.com/christian-bromann/channelstack/pull/128))

### Packages

- **The Python SDK:**
  - Email waits take the channel's user and app handles as from_ ([#101](https://github.com/christian-bromann/channelstack/pull/101))

## [0.1.1] - 2026-11-26

The first release on npm and crates.io, and of `pytest-channelstack` on PyPI. What channelstack does is under [0.1.0](https://github.com/christian-bromann/channelstack/blob/main/CHANGELOG.md#010---2026-11-26).

### Fixed

- The npm packages and the Rust crate are published. 0.1.0's release stopped at a workflow bug ([#98](https://github.com/christian-bromann/channelstack/pull/98)), after publishing only the `channelstack` Python package.

## [0.1.0] - 2026-11-26

The first version of channelstack, a test harness for the apps and agents you build for Slack, GitHub, Linear, Notion, Resend and Gmail. Everything below is new.

### The fakes

- **Slack:**
  - Conversations, threads and DMs, with reactions, edits and deletes.
  - Block Kit buttons and select menus, modals, slash commands and message shortcuts.
  - Streams with Stop, the agent split view (`assistant.threads.setStatus`, suggested prompts), and Socket Mode.
  - Signed delivery, with Slack's retries and `X-Slack-Retry-Num`.
- **GitHub:**
  - Repositories with an in-memory git store, issues, pull requests, reviews and review comments, check runs and statuses, App installations.
  - Signed webhooks with GUIDs, the App's delivery log, and redelivery.
  - The REST API is served at `github.localhost` and at the GHE-style `/api/v3`.
- **Linear:** teams, issues and comments, delegation, agent sessions and their activities, elicitations, the stop signal, and signed webhooks.
- **Notion:** pages, blocks, databases and rows, comments and discussions, connections, and signed integration webhooks.
- **Resend:** sending, batches, idempotency keys, the receiving API with attachments and the raw message, domains, the `@resend.dev` test addresses, and Svix-signed webhooks on Resend's retry schedule.
- **Gmail:** a mailbox the agent reads and sends from through the Gmail API (messages, threads, labels, history, `watch`), Google's token endpoint, and Pub/Sub pushes with OIDC tokens, at most one a second.
- **Realistic by default:** every fake uses the platform's own id formats, error codes and payload shapes, and refuses what the platform refuses. GitHub's, Linear's, Resend's and Gmail's answers are checked against their published descriptions.

### Testing

- **`channelstack/vitest`:** a plugin that attaches to a running server or starts one, gives every test its own session and the `slack`, `github`, `linear` and `notion` fixtures, and adds the matchers.
- **Actor-first tests:** `ana.say("@my-agent hi", { channel })`, `ben.click("Approve", { message })`, `mo.comment("…", { issue })`. Each test creates its own people and places, and its session cleans them up.
- **Matchers that wait for your app:**
  - Positive checks poll.
  - Negative and exact-count checks wait until the app has been quiet for a window they watch from start to end.
  - A failure says what the app left open.
- **Delivery and failures:** Slack's retry, redelivery, bad signatures and stale timestamps, rate limits and dropped sockets.
- **`channelstack/checks`:** `slackChecks()`, `githubChecks()`, `linearChecks()`, `notionChecks()`, `resendChecks()` and `googleChecks()` register standard behaviour checks, each named after a bug class.
- **`pytest-channelstack`:** pytest fixtures, and `expect(...)` with every matcher, its semantics and its `not_to_…` form.
- **Rust:** `channelstack::expect` in the SDK crate, with every matcher and its `not_to_…` form, each awaited to a `Result` (`Error::Expectation` when it fails).

### Live mode

- With sandbox credentials in the environment, the same tests act on real Slack, GitHub, Linear and Notion workspaces, Resend teams and Gmail accounts, and read the results back. channelstack never relays events to your app.
- Workspace allowlists, run tags and cleanup.
- A browser actor that types and clicks as a person in Slack (`say`, `reply`, `click`), using a session saved with `channelstack login slack`. Slack's Stop, select menus, shortcuts, slash commands, modal submit and close, and the agent-thread steps aren't done live yet, and skip.
- `channelstack doctor` and `channelstack sweep`.
- A step live mode can't do skips its test, with the reason.

### Tools

- **The server:** a single binary, serving the six fakes at `*.localhost` through portless, or on one port with `--no-portless`. `channelstack env` prints what the agent needs.
- **Proxy mode** (`--proxy`): for agents that hard-code `slack.com` or `api.github.com`, with a CA that only the agent trusts.
- **The attach CLI:** `channelstack slack say|reply|react|click|stop`, `show`, `tail`, `deliveries` and `redeliver`, in a shared `dev` session.
- **The UI:** the `dev` session's conversations as a person reads them, next to every delivery and API call.
- **`channelstack mcp`:** the attach CLI's commands as MCP tools for coding agents, with a `channelstack` skill.
- **SDKs for TypeScript, Python and Rust,** generated from one spec, with the same handles, waits and errors in each.

### Packages

- **npm:** `channelstack` (the CLI, the server, the TypeScript SDK, `channelstack/vitest` and `channelstack/checks`), with the server binary for each platform as `@channelstack/server-<platform>-<arch>`.
- **PyPI:** `channelstack`, the Python SDK, and `pytest-channelstack`.
- **crates.io:** `channelstack`, the Rust SDK.
- **GitHub releases:** the server binary for macOS, Linux and Windows, with SHA-256 checksums.

### Docs

- The docs at channelstack.dev/docs: quickstarts for Chat SDK, AI SDK and Pi, a guide, a page per platform, and a reference generated from the spec.
- **Docs for agents:** every page as Markdown (its URL plus `.md`, or `Accept: text/markdown`), `llms.txt` and `llms-full.txt`, an MCP server for the docs at `https://channelstack.dev/mcp`, and a **Copy page** menu on every page that opens it in ChatGPT, Claude, Codex or Cursor.
