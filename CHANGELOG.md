# Changelog

All notable changes to channelstack. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

The first version: everything below is new.

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
- **Realistic by default:** every fake uses the platform's own id formats, error codes and payload shapes, and refuses what the platform refuses. GitHub's and Linear's answers are checked against their published schemas.

### Testing

- **`channelstack/vitest`:** a plugin that attaches to a running server or starts one, gives every test its own session and the `slack`, `github`, `linear` and `notion` fixtures, and adds the matchers.
- **Actor-first tests:** `ana.say("@my-agent hi", { channel })`, `ben.click("Approve", { message })`, `mo.comment("…", { issue })`. Each test creates its own people and places, and its session cleans them up.
- **Matchers that wait for the agent:**
  - Positive checks poll.
  - Negative and exact-count checks wait until the agent has been quiet for a window they watch from start to end.
  - A failure says what the agent left open.
- **Delivery and failures:** Slack's retry, redelivery, bad signatures and stale timestamps, rate limits and dropped sockets.
- **`channelstack/checks`:** `slackChecks()`, `githubChecks()`, `linearChecks()` and `notionChecks()` register standard behaviour checks, each named after a bug class.
- **`pytest-channelstack`:** pytest fixtures, and `expect(...)` with the matchers' semantics for conversations, text and buttons, comments and Linear sessions.

### Live mode

- With sandbox credentials in the environment, the same tests act on real Slack, GitHub, Linear and Notion workspaces and read the results back. channelstack never relays events to the agent.
- Workspace allowlists, run tags and cleanup.
- A browser actor for the actions only a person can do in Slack, using a session saved with `channelstack login slack`.
- `channelstack doctor` and `channelstack sweep`.
- A step live mode can't do skips its test, with the reason.

### Tools

- **The server:** a single binary, serving the four fakes at `*.localhost` through portless, or on one port with `--no-portless`. `channelstack env` prints what the agent needs.
- **Proxy mode** (`--proxy`): for agents that hard-code `slack.com` or `api.github.com`, with a CA that only the agent trusts.
- **The attach CLI:** `channelstack slack say|reply|react|click|stop`, `show`, `tail`, `deliveries` and `redeliver`, in a shared `dev` session.
- **The UI:** the `dev` session's conversations as a person reads them, next to every delivery and API call.
- **`channelstack mcp`:** the attach CLI's commands as MCP tools for coding agents, with a `channelstack` skill.
- **SDKs for TypeScript, Python and Rust,** generated from one spec, with the same handles, waits and errors in each.

### Docs

- The docs at channelstack.dev/docs: quickstarts for Chat SDK, AI SDK and Pi, a guide, a page per platform, and a reference generated from the spec.
