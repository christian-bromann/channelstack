---
title: "Vitest plugin"
order: 1
description: "The channelstack() Vitest plugin from channelstack/vitest: its options, its modes, what it adds to a run, and the fixtures every test gets."
---

# Vitest plugin

The options of `channelstack()` from `channelstack/vitest`, what the plugin adds to a Vitest run, and the fixtures it gives every test. For a walkthrough, see [Writing tests](/docs/guide/writing-tests).

```ts title="vitest.config.ts"
import { defineConfig } from "vitest/config";
import channelstack from "channelstack/vitest";

export default defineConfig({
  plugins: [channelstack({ mode: "auto", timeout: "10s", quietFor: "750ms" })],
});
```

## Signature

```ts
import channelstack from "channelstack/vitest";

function channelstack(options?: ChannelstackIntegrationOptions): Plugin;
```

| Requirement | Value |
|---|---|
| Package | `channelstack` (`npm i -D channelstack`) |
| Import | Default export of `channelstack/vitest` |
| Vitest | `>=5.0.0 <6` (an optional peer dependency) |
| Node | `>=22` |

## Options

```ts
interface ChannelstackIntegrationOptions {
  server?: string;
  mode?: "auto" | "attach" | "start";
  timeout?: Duration;
  quietFor?: Duration;
}
```

| Option | Type | Default | Meaning |
|---|---|---|---|
| `server` | `string` | `CHANNELSTACK_URL`, else the URL in `<home>/server.json` | Attach to the server at this URL. Its token comes from `CHANNELSTACK_TOKEN`, or from `server.json` when the URLs match |
| `mode` | `"auto" \| "attach" \| "start"` | `"auto"` | How the run finds its server. See [Modes](#modes) |
| `timeout` | `Duration` | `"10s"` | Default timeout of every matcher, and of `channelstack.quiet()` |
| `quietFor` | `Duration` | `"750ms"` | Default quiet window of negative and exact-count matchers, and of `channelstack.quiet()` |

A `Duration` is milliseconds as a number, or a string such as `"250ms"`, `"3s"`, `"1m"`.

`timeout` sets the matchers' default only. The SDK's own waits (`waitForReply`, `waitForComment`, `latestReply`, `settled`, …) keep their default of `10s` unless a call passes `timeout`.

## Modes

| Mode | Server running | No server running |
|---|---|---|
| `auto` | Attaches to it | Starts a private one for the run |
| `attach` | Attaches to it | Fails the run: `` No running channelstack server found. Start one with `npx channelstack`, or set CHANNELSTACK_URL and CHANNELSTACK_TOKEN. `` |
| `start` | Ignores it, starts a private one | Starts a private one for the run |

"Running" means a server at `server` (or `CHANNELSTACK_URL`, or the one in `server.json`) answers `GET /_channelstack/status` with the token within 2 seconds.

A private server is the binary of the installed platform package (`@channelstack/server-<platform>-<arch>`), or `CHANNELSTACK_SERVER_BIN`. It runs as `channelstack start --no-portless --port 0 --server-file <temporary file>`, so it uses a free loopback port, no `*.localhost` names, and never touches the shared `server.json`. It inherits the test run's environment, `CHANNELSTACK_<CHANNEL>_WEBHOOK_URL` and live credentials included. It has 15 seconds to become ready, and stops when the run ends.

## What the plugin adds

| Piece | What it does |
|---|---|
| Global setup | Runs once per run: attaches to or starts the server (by `mode`), and hands its URL, its token, `timeout` and `quietFor` to the test workers through Vitest's `provide`. Stops a server it started when the run ends |
| Setup file | Runs in every worker, before the project's own `setupFiles`: one client per worker, one session per test, the fixtures below, and the matchers registered with `expect.extend` |
| Types | Augments `vitest`: `TestContext` gets the fixtures, `Matchers` gets every [matcher](/docs/reference/matchers), `ProvidedContext` gets `channelstack` |
| `test.env` | Sets `CHANNELSTACK_VITEST_OPTIONS` to the plugin's options as JSON, for the global setup to read |

The setup file comes first in `setupFiles`, so its `beforeEach` work (opening the session, the fixtures) runs before the project's hooks, and its cleanup runs after them. A project's own hooks can use the fixtures.

The token goes to the workers directly. Nothing a test spawns inherits it.

## Sessions

Every test gets its own session in the server's shared world. The session opens before the test's hooks run and closes after them, whether or not the test names a fixture. Closing it removes everything the test created: people, channels, repositories, teams, pages, faults. Disposing never fails a test.

Relative fixture paths in a test (`files: "./fixtures/web"`, `content: { path: "./notes.md" }`) resolve from the test file's directory.

## Fixtures

Every fixture is automatic. Destructure what a test needs:

```ts title="support.test.ts"
import { expect, test } from "vitest";

test("answers in the thread", async ({ slack, channelstack }) => {
  const ana = await slack.createUser({ name: "Ana" });
  const channel = await slack.createChannel({ participants: [ana, slack.app] });
  const msg = await ana.say("@my-agent hi", { channel });
  await expect(msg.thread).toHaveReplyFrom("my-agent");
  await channelstack.quiet();
});
```

| Fixture | Type | What it is |
|---|---|---|
| `channelstack` | `ChannelstackFixture` | The server itself. See below |
| `slack` | `SlackFixture` | The test's view of the fake (or live) Slack workspace |
| `github` | `GitHubFixture` | The test's view of the GitHub organization |
| `linear` | `LinearFixture` | The test's view of the Linear workspace |
| `notion` | `NotionFixture` | The test's view of the Notion workspace |

The channel fixtures' members are listed in the API reference: [`SlackFixture`](/docs/reference/api/slack#slackfixture), [`GitHubFixture`](/docs/reference/api/github#githubfixture), [`LinearFixture`](/docs/reference/api/linear#linearfixture), [`NotionFixture`](/docs/reference/api/notion#notionfixture).

A suite builds its own fixtures on these with `test.extend`:

```ts title="fixtures.ts"
import { test as base } from "vitest";
import type { SlackConversation, SlackUser } from "channelstack/client";

export const test = base.extend<{ ana: SlackUser; support: SlackConversation }>({
  ana: async ({ slack }, use) => use(await slack.createUser({ name: "Ana" })),
  support: async ({ slack, ana }, use) =>
    use(await slack.createChannel({ name: "support", participants: [ana, slack.app] })),
});
```

### `ChannelstackFixture`

| Member | Signature | Returns | Notes |
|---|---|---|---|
| `url` | `readonly url: string` | `string` | Control API and UI base, e.g. `https://channelstack.localhost` |
| `env` | `env(): Promise<Record<string, string>>` | Env vars for the agent | What [`channelstack env`](/docs/reference/cli#channelstack-env) prints: fake tokens, signing secrets, API URLs |
| `quiet` | `quiet(options?: { quietFor?: Duration; timeout?: Duration }): Promise<void>` | Resolves when the agent is quiet in this test's session | Quiet: no call in flight, no delivery in flight or about to be retried, no open stream, for `quietFor`. Defaults: the plugin's `quietFor` and `timeout` |
| `reset` | `reset(): Promise<void>` | `void` | Drops all state on every channel, for every session. Avoid it in parallel suites. Refused with `unsupported_in_live` when a channel is live; that refusal fails the test, since it belongs to no session |

## Live refusals skip tests

When a channel runs live, some operations can't run there. The plugin turns two refusals into a skipped test, with the reason, instead of a failure:

| Error code | Means | Outcome |
|---|---|---|
| `unsupported_in_live` | The operation has no live counterpart, or not yet (delivery chaos, a person's Re-run) | Test skipped: `live: <message>` |
| `action_requires` | It works live only with a piece this run lacks: the browser actor, or proxy mode | Test skipped: `live: <message>` |
| Any other code | `live_misconfigured`, `live_not_allowlisted`, `fake_actor_in_live_world`, a platform error, … | Test fails |

The skip is per test: the refused request names its session, so concurrent tests skip only themselves. A fake run never sees these refusals, so every test runs in full on every fake run.

A channel fixture that is refused while it is set up (its live backend isn't built, or its credentials are set in part) doesn't touch the other channels' tests. The refusal is kept and raised the first time the test uses that fixture: it skips the test for the two codes above and fails it for any other.

The matchers' failure messages add what the agent left open ("Still open: …"). That read never turns a failing test into a skipped one.

See [Live mode](/docs/guide/live-mode) and the [error codes](/docs/reference/api/errors).
