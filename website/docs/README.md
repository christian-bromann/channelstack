# The channelstack docs

The plan for the docs at channelstack.dev/docs, and how to write a page. Every `.md` or `.mdx` file in this folder, except this one, is a page under `/docs`.

## How the docs are organised

The structure follows [vite.dev](https://vite.dev/guide/): a short **Introduction** a newcomer reads top to bottom, a **Guide** that covers one feature per page, then the **Platforms**, and a **Reference** that someone looks things up in. Inside that, every page is one of the four kinds [Diátaxis](https://diataxis.fr/) describes, and never two at once:

| Kind | Answers | Reads like | In these docs |
|---|---|---|---|
| Tutorial | "Teach me" | A lesson: do this, see that. It works every time and explains little | Getting started |
| How-to | "How do I…?" | Steps toward one goal, for someone who already knows the basics | Most of the Guide, the platform pages |
| Explanation | "Why is it like this?" | A discussion: context, trade-offs, alternatives | Why channelstack, How it works, Waiting and quiet |
| Reference | "What exactly is…?" | Austere and complete, laid out like the product | Everything under Reference |

A page that starts teaching in the middle of a how-to links to the explanation instead. The reference never tells a story.

### The sidebar

The docs have two areas, each with its own sidebar and its own link in the top navigation: the **Guide** (Introduction, Quickstarts, Guide and Platforms) and the **Reference**. A platform has a page in each, a guide and an API page, and they link to each other; neither sidebar lists a platform twice.

The folder is the section and the frontmatter's `order` is the position in it. A page can name another section of its area in its frontmatter (`section: "Platform APIs"`, which the generated platform pages do).

**Introduction** (`docs/`)

| Page | Kind | What it covers |
|---|---|---|
| Overview (`index.mdx`) | Explanation | What channelstack is in one screen, and who it's for (bots, apps, integrations and AI agents on the four platforms): a test scripts people, the fake platform delivers to the unchanged app, the matchers read what a person would see. Animated: the request flow |
| Why channelstack (`why.md`) | Explanation | Why apps and agents on these platforms are hard to test (async replies, retries, signatures, Stop, no sandbox), what mocking the SDK misses, why fakes plus live runs |
| Getting started (`getting-started.mdx`) | Tutorial | Install, start the server, `channelstack env`, run a small Bolt bot, write and pass a first Vitest test, then break the bot and watch it fail. Animated: the terminal |

**Quickstarts** (`docs/quickstarts/`)

One per agent framework, in the order people use them with channelstack. Each is a short tutorial: the framework's own agent, pointed at the fakes, and a first passing test. Each was followed step by step against a local channelstack, so the steps are known to work. The Chat SDK and AI SDK ones also match a reference agent in `examples/agents/` that CI runs; Pi has no reference agent.

| Page | Kind | What it covers |
|---|---|---|
| Chat SDK | Tutorial | A Chat SDK bot (`chat` with `@chat-adapter/slack`, and the GitHub and Linear adapters) |
| AI SDK | Tutorial | A Bolt app that streams an AI SDK answer, with the AI SDK's mock model |
| Pi | Tutorial | A Pi agent in Slack |

**Guide** (`docs/guide/`)

| Page | Kind | What it covers |
|---|---|---|
| How it works | Explanation | One server, four fakes, the control API; sessions in one shared world; the transcript the matchers and UI read. Animated: the architecture, and parallel sessions |
| Connecting your app | How-to | `channelstack env`, each SDK's base-URL option, where the server delivers (`CHANNELSTACK_<CHANNEL>_WEBHOOK_URL`), Socket Mode, TLS trust per runtime, `--no-portless` |
| Writing tests | How-to | The Vitest plugin, fixtures, actor-first calls, giving the app access explicitly, shared people with `test.extend`, files and fixtures paths, cleanup |
| Waiting and quiet | Explanation | Why matchers wait, positive vs negative and exact-count checks, the quiet window, "Still open:" messages, timeouts. Animated: the quiet window |
| Delivery and failures | How-to | Retries, bad signatures, stale timestamps, redelivery, faults (rate limits, dropped sockets), what each proves. Animated: Slack's retry |
| Standard checks | How-to | `slackChecks()` and the others: what each check catches, the options they need, skipping one |
| pytest | How-to | `pytest-channelstack`: fixtures, `expect(...)`, the ini settings, modes |
| The dev loop: CLI and UI | How-to | `channelstack slack say`, `show`, `tail`, `deliveries`, `redeliver`, the UI's login link, the shared `dev` session |
| MCP for coding agents | How-to | `channelstack mcp`, its tools, the skill, the loop a coding agent runs |
| Proxy mode | How-to | Apps that hard-code `slack.com`: `--proxy`, `env --proxy`, the CA, Go in Docker. Animated: the routing |
| Live mode | How-to | The same tests against real sandboxes: credentials, allowlists, the browser actor, what skips and why, `doctor` and `sweep`. Animated: fake and live side by side |
| Running in CI | How-to | GitHub Actions: start, `env`, the agent, the tests; a nightly live job |
| Troubleshooting | How-to | Symptoms to fixes: nothing delivered, TLS errors, timeouts, `not_in_channel`, `missing_scope`, flaky negatives |

**Platforms** (`docs/platforms/`)

One page per platform, the same shape on each: what the fake covers, connecting an app built on that platform's SDKs, the people and objects a test creates, the actions people take, what to check, delivery specifics, and what live needs.

| Page | Kind |
|---|---|
| Slack | How-to |
| GitHub | How-to |
| Linear | How-to |
| Notion | How-to |

**Reference** (`docs/reference/`)

The reference is generated wherever there's one source for it, so it can't drift from the product.

| Page | What it lists | Source |
|---|---|---|
| Vitest plugin | `channelstack()` options, the `channelstack` fixture, modes | Written by hand |
| Client and sessions, Slack API, GitHub API, Linear API, Notion API (`api/`) | Every handle, field, method and wait: the call in each SDK's language, every parameter with its name in each language, what it returns, its errors, and what it needs live | **Generated** from `spec/ir.json` by `codegen/src/emit/docs.ts`, with the SDKs' own naming |
| Errors (`api/errors.mdx`) | Every error code: what channelstack's own mean, which platform's a fake's codes are, the SDK class, and the methods that raise it | **Generated**, from the IR and `x-channelstack-errors` |
| Matchers | Every matcher: subject, arguments, waits how, fails with what. The pytest names next to each | Written by hand; to be generated from `integrations/matchers-core` |
| CLI | Every command and flag | Written by hand; to be generated once the CLI's commands are one table |
| Environment variables | What the server reads, what `channelstack env` prints, the live credentials | Written by hand; to be generated once they're declared in one place |
| SDKs | The TypeScript, Python and Rust SDKs: installing, connecting, the naming in each language | Written by hand |

`pnpm sdk` writes the generated pages along with the SDKs, and `pnpm sdk:check` fails CI when they're stale. Never edit them: change the routes, or the emitter. The site's build checks that every link reaches its page and heading, so a renamed method breaks the build of a page that links to it.

## Writing a page

- **Open with what the page is for,** in one or two sentences, before any heading. Then H2 sections; the right-hand outline is built from H2 and H3.
- **Show, then explain.** A code block early, then what it does. Every example is one that runs against the reference agents (`api/examples/` has the real ones).
- **Plain words, short sentences,** the way the rest of the repository is written. Name things the way the API does.
- **Describe what's built.** A feature that isn't built yet isn't documented as if it were; at most a sentence says it's coming, with its issue.
- **Link across kinds** instead of mixing them: a how-to links to the explanation of why, and to the reference for every option.

### Frontmatter

```yaml
---
title: Writing tests   # the sidebar label and page title
order: 3               # position within the section, ascending
description: …         # the meta description: one sentence
---
```

### Callouts

GitHub's alert syntax, which reads fine on GitHub too:

```md
> [!TIP]
> A tip: something that saves time.

> [!NOTE]
> Context worth knowing, but not required.

> [!WARNING]
> Something that breaks or costs data if ignored.
```

### Code

Fenced blocks are highlighted at build time (`ts`, `tsx`, `js`, `python`, `rust`, `bash`, `json`, `yaml`, `diff`, `ini`). A `title` names the file: ` ```ts title="vitest.config.ts" `.

The same example in several languages or package managers goes in tabs:

````mdx
<CodeGroup>

```ts title="TypeScript"
await expect(msg.thread).toHaveReplyFrom("my-agent");
```

```python title="Python"
await expect(msg.thread).to_have_reply_from("my-agent")
```

</CodeGroup>
````

### Animations

The animated figures are React components in `src/components/docs/`, available in every page without an import:

| Component | Shows | Used on |
|---|---|---|
| `<RequestFlow />` | A test's message reaching the app and its reply coming back | Overview, How it works |
| `<TerminalSession />` | The getting-started commands and their output, typed out | Getting started |
| `<SessionScopes />` | Parallel tests, each in its own session of one shared workspace | How it works |
| `<QuietWindow />` | A negative check watching the app until it has been quiet long enough | Waiting and quiet |
| `<RetryTimeline />` | Slack retrying a slow delivery, and an app answering once | Delivery and failures |
| `<ProxyRouting />` | Platform hosts going to the fakes, every other host passing through | Proxy mode |
| `<FakeOrLive />` | The same test against the fake and against a real sandbox | Live mode |

Each one carries its meaning in text too (a caption, and text for screen readers), loops quietly, and holds still for people who ask for reduced motion.
