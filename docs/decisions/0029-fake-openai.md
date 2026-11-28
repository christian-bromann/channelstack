# 0029: A fake OpenAI, scripted per test

Status: accepted, 2026-11-27, on the maintainer's instruction, after three review rounds of the interface ([phase-log/model-providers/interface-draft.md](../../phase-log/model-providers/interface-draft.md), the full design). Built in phases 13 and 14. It reverses AGENTS.md's settled **Models** row ("channelstack doesn't mock LLMs"). It also reverses the same clause in [decision 0011](0011-reference-agents.md) and [decision 0027](0027-multiple-apps.md), and [devx.md section 6](../devx.md#6-the-model).

## What was decided

- **channelstack fakes OpenAI's API on the wire,** at `https://openai.localhost/v1`. It covers Chat Completions, the Responses API and the Conversations API. Phase 14 adds images, audio, files and OpenAI's built-in tools. `channelstack env` prints `OPENAI_BASE_URL` and an `OPENAI_API_KEY`, so an agent needs no code change, only its environment.
- **Realistic on the wire, never realistic content.** Event shapes, ids, tool calls, errors, rate-limit headers and timing are OpenAI's. What the model says is what the test scripted. Answer-quality evals stay out of scope.
- **Only OpenAI.** No Anthropic and no other provider. OpenAI-compatible gateways come for free: OpenRouter, Vercel AI Gateway, LiteLLM, Groq, Together, Ollama, vLLM, Azure OpenAI and others. OpenRouter's and DeepSeek's reasoning fields and Azure's deployment paths are served too, because they're cheap.
- **A test scripts the model on the `openai` fixture:**
  - **A turn list:** `const ai = await openai.respond(turns, { when })`. A turn is text, stream chunks, tool calls, reasoning, a refusal, media or an error. Lists are used in arrival order.
  - **A responder:** a function of the normalised request (the conversation, the tools offered, the call's channel context). It runs in the test process: the server holds the agent's request open, and the SDK answers over a long poll.
- **No default answer.** A model call that no script answers gets a 400 `channelstack_no_script` naming the missing `respond(…)`. The test fails at once in its waiting matchers, or at the latest when its session closes. The same goes for a list that runs out, a responder that throws, and a script that does what the real API can't (§5.4 of the design).
- **Calls are attributed to sessions without the agent's help,** strongest evidence first:
  1. ids the fake minted;
  2. a tag the agent sends (`user`, metadata, a header);
  3. ids the session owns, appearing in the prompt;
  4. text the session's people wrote.

  Two parallel tests that send the same text are the test author's to keep apart. The call goes to the oldest message's session, and a failure says it was attributed by order. Calls in one test whose order nobody controls are answered by a responder reading `request.context`, or with `when: { from, in }`.
- **Timing and failure are scripted per turn:** the first token's delay, the delay between chunks, a stream that breaks after N chunks (an error event, a dropped connection, or a stall), and holding a stream until the test resumes it. OpenAI's documented errors are scripted per call (rate limits, `slow_down`, quota, spend and usage limits, 5xx, `server_is_overloaded`, access errors). There is also a per-session rate limiter with truthful `x-ratelimit-*` headers.
- **Asserting on what the agent sent:**
  - `calls()`, `toolCalls()` (each tool call joined with the agent's result) and `request.context`;
  - matchers: `toHaveSent`, `not.toHaveSentSecrets`, `toHaveOfferedTool`, `toHaveSentToolResult`, `toHaveSentFile`, `toBeAborted` and `toHaveAnswered`.
- **Built-in tools are scripted, never run.** That covers web and file search, code interpreter, image generation, remote MCP, shell, computer, apply patch and custom tools. The fake never calls an MCP server.
- **What isn't served:**
  - background responses and `n > 1`: refused with a 400 `unsupported_in_fake`;
  - embeddings, vector stores, Realtime and batches: OpenAI's 404;
  - the Assistants and Videos APIs: OpenAI has shut them down.
- **Proxy mode always routes `api.openai.com` to the fake,** like every other routed host.
- **The standard checks take the model** (`slackChecks({ app, model: "openai" })`). They script it themselves and add one check per model bug class: slow model, model error, model retry, a broken stream, Stop cancels the model, no secrets in the prompt. There is no `channelstack check` command.
- **Two phases, two stacked pull requests.** Phase 13 is the core, and phase 14 adds media and built-in tools. Phase 14's branch starts from phase 13's, and its PR is opened while 13 is in review. It merges once 13 is merged and tagged. This is an exception to AGENTS.md's "one phase at a time", on the maintainer's instruction.

## Why

- **The raw SDK has no fake model.** The primary persona ([audience.md](../audience.md) §1) often builds on the `openai` SDK, a gateway, or a framework whose fake doesn't sit on the wire. Before this, they mocked `fetch` or paid for real calls.
- **The worst channel bugs come from the model's timing and failures,** which in-process fakes don't produce:
  - a slow first token plus Slack's 3-second retry gives duplicate replies;
  - a stream that breaks halfway never finalises;
  - a 503 leaves the status stuck;
  - Stop doesn't cancel the model request.
- **Jobs 3 and 5** ("tell me whether my bot has the usual bugs", "in CI with no secrets") need an unmodified agent. An in-process fake needs code changes; a base URL doesn't.
- **Two serious frameworks built one themselves:** OpenClaw's mock-openai and Hermes's loopback fake ([framework-testing.md](../framework-testing.md)). The prior art (emulate's `@emulators/ai`, LangChain's `fakeModel`, the AI SDK's mock models, CopilotKit's aimock) is compared in §2 of the design.
  - None of them scopes scripts to a test without the agent's help.
  - `fakeModel`'s functions can't see the tools offered.
  - emulate sends no `response.failed`, no mid-stream errors, and no rate-limit headers by default.

## What changes

- **AGENTS.md:** the **Models** row, the **Addresses** row (`openai.localhost`), and the opening summary.
- **devx.md:** the header, the list of hosts, the scope bullet and section 6. **implementation-plan.md:** the "Faking the LLM" non-goal. **audience.md:** job 5. **architecture.md:** providers next to drivers.
- **code-map.md:** the planned modules: `server/src/providers/openai/`, `core/stream/`, `core/attribution/`, the SDKs' `responder` runtime module, and the matchers.
- **docs/phases.md:** phases 13 and 14. **Built in those phases and updated there:** the website, README, `index.html`, the skill, and the reality matrix.

## Alternatives considered

- **Keep the rule: frameworks bring their own fake model.** Rejected for the reasons above. The matchers still hold with a real model or a framework fake, so nothing forces anyone onto this one.
- **Run responders in the server** (shipping a function's source) or **as rules in a small language.** Rejected: closures don't serialise, Python and Rust can't ship JavaScript, and the control API would run arbitrary code. Templates (`{lastUserText}`) cover the CLI and UI, where no test function exists.
- **A default answer for unscripted calls.** Rejected by the maintainer: a made-up answer hides a missing script, and an echo makes text matchers pass by accident.
- **Fail both tests when two parallel tests send the same text.** Rejected by the maintainer: keeping parallel tests apart is the test author's job, and the failure message says how.
- **Requiring the agent to send a session header,** or one server per test (emulate). Rejected: the agent is configured once, with one base URL, for every test.
- **Anthropic's Messages API.** Rejected by the maintainer: OpenAI's wire format, through the gateways, covers the persona.
