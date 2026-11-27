# A fake OpenAI: interface draft

> Status: **draft for the maintainer's review**, 2026-11-27. Nothing is built, and there is no decision record yet.
> Scope: **OpenAI only**: Chat Completions and the Responses API at `https://openai.localhost/v1`. Anthropic comes later. The script vocabulary (a turn: text, chunks, tool calls, reasoning, an error) has no OpenAI-specific parts, so Anthropic's Messages API can reuse it as it is.
> It reverses the settled `AGENTS.md` row **Models**: "channelstack doesn't mock LLMs". The new rule: **realistic on the wire, never realistic content.** Answer-quality evals stay out of scope.

## 1. Why

The primary persona ([audience.md](../../docs/audience.md) §1) builds on the raw OpenAI SDK, on the AI SDK, LangChain or Mastra, or on an OpenAI-compatible gateway. Today [devx.md §6](../../docs/devx.md#6-the-model-is-yours) sends them to their framework's fake model. That fails in three ways:

1. **The raw SDK has no fake model.** Someone using `openai` directly mocks `fetch` or calls the real API.
2. **The worst channel bugs come from the model's timing and failures, and in-process fakes can't produce them.** A slow first token plus Slack's 3-second retry gives duplicate replies. A stream that fails halfway never finalises its Slack stream. A 429 or a 503 leaves the agent's status stuck on "Thinking…". Stop doesn't cancel the model request. An in-process fake returns instantly and never fails like the network does.
3. **Jobs 3 and 5** ("tell me whether my bot has the usual bugs", "in CI with no secrets") need an **unmodified** agent. You can't swap in an in-process fake without changing the agent's code, but you can change `OPENAI_BASE_URL`.

OpenClaw (mock-openai) and Hermes (a loopback fake LLM server) each built a wire-level fake on their own ([framework-testing.md](../../docs/framework-testing.md)). It is the one part of their harnesses channelstack doesn't offer yet.

## 2. Prior art in short

Read from source, 2026-11-27. These are ideas only. channelstack copies no emulator code (`AGENTS.md`, "Independence").

| | What it is | Take | Avoid |
|---|---|---|---|
| **emulate `@emulators/ai`** (v0.15, Apache-2.0) | A wire fake for Chat Completions and Responses (and Anthropic and Gemini): one codec per wire format, decoding into a neutral request and encoding a neutral reply. Ordered rules: the first match wins, with `times` budgets and seeded `variants`. Faults: `ttftMs`, `chunkDelayMs`, and `afterChunks` with `disconnect` or `stall`. A call log at `/_ai/calls`; `strict` prints the missing rule | The neutral request and turn with a codec per format. The whole reply is decided before the first byte, and only the transport is paced. A broken stream errors and never closes cleanly. Tool-argument chunks split only between JSON tokens. A budget per rule, so the SDK's retries spend the next turn. The delivery outcome on each call (`completed`, `client_aborted`) | **No per-test scope**: one rule set per process, so parallel tests need one server each. Only case-sensitive substring matching on the newest message. No rate-limit headers unless a rule sets them. No `response.failed` or `error` events. Rejecting unknown tool shapes outright breaks Codex (#436) |
| **LangChain `fakeModel`** (`@langchain/core/testing`) | In-process. A FIFO queue: `.respond(message \| Error \| (messages) => message)`, `.respondWithTools([...])`, `.alwaysThrow`, `.structuredResponse`. `.calls` records messages and options, errors included. Running out throws, naming the call number | The fluent queue. A factory computed from the conversation. A clear "ran out at call N". Errors that use up a turn like any other | **The factory sees only the messages: not the tools offered, the model or the options.** A factory is one queue entry, not a standing rule. Tool-call turns get made-up content |
| **AI SDK `MockLanguageModelV3`/`V4`** (`ai/test`) | In-process. `doGenerate`/`doStream` each take a function of the full call options, one result, or an array by call number. `simulateReadableStream({ initialDelayInMs, chunkDelayInMs })`. Records `doGenerateCalls` and `doStreamCalls` | "A function, a value or a list" as one overload. A separate first delay and chunk delay. The function sees everything: prompt, tools, tool choice, response format, headers | A list that silently returns `undefined` once used up. Faking above the wire misses the SDK's parsing and retries, which is the gap this fake fills |
| **OpenClaw mock-openai** (QA lab, and the e2e server) | QA lab: Responses over SSE and WebSocket, scenarios hard-coded and **picked by regexes over the prompt** ("reply exactly `X`"). It scopes sessions by `client_metadata.session_id` or an affinity header, and fails loudly when that is missing or ambiguous. `holdNextContinuation` parks a request until released. The e2e server: Chat and Responses, scripted by a JSON file it re-reads per request (`responses[]`, `default`, `hold`) | Session identity from what the request already carries, loud on ambiguity. Holding a request for race tests. Realistic 429 bodies with `retry-after-ms`, and 503s | Magic phrases in prompts. Scenarios as server code. Scripting by a polled file |
| **CopilotKit aimock** (`@copilotkit/aimock`) | The closest packaged prior art: `onMessage("hello", {...})`, matchers (`turnIndex`, `hasToolResult`, predicates), chaos scoped by an `X-Test-Id` header, a journal, `x-ratelimit-*` on every response, record and replay, model misbehaviour (bad tool args, empty replies) | Rate-limit headers always. Misbehaviour as a fault class | Scoping that needs a header the agent must send |
| Others | LiteLLM `mock_response` (in-process); StacklokLabs mockllm (a YAML map from prompt to reply); Stainless steady and Prism behind the official SDKs' `scripts/mock` (valid against the schema, no behaviour); VCR cassettes (break when prompts change) | | |

**What follows for channelstack:**

1. A responder gets the **whole normalised request** (§4.4), which fixes `fakeModel`'s blind spot.
2. Scripts are **scoped to the test's session** without the agent sending anything (§8). This is what neither emulate nor aimock has.
3. Everything a stream can do on the wire, including `response.failed`, the mid-stream `error` event and rate-limit headers by default.

The official SDKs' retry rules shape the error design (§7.3). openai-node and openai-python retry 408, 409, 429, 5xx and connection errors twice (`maxRetries: 2`). `x-should-retry` overrides that. They wait `retry-after-ms`, else `retry-after`, honoured only up to 60s in Node and 120s in Python. Otherwise they back off from 0.5s up to 8s. They send `x-stainless-retry-count`, and never retry once a 200 stream has started.

## 3. At a glance

| | |
|---|---|
| Host | `https://openai.localhost/v1` (portless); `http://localhost:4500/openai/v1` with `--no-portless`; `api.openai.com` in proxy mode (§12.3) |
| `channelstack env` | `OPENAI_BASE_URL=https://openai.localhost/v1`, `OPENAI_API_KEY=sk-proj-…` (random per install, in `secrets.json`, like every fake token) |
| Endpoints | `POST /v1/chat/completions`, `POST /v1/responses`, `GET`/`DELETE /v1/responses/{id}`, `GET /v1/responses/{id}/input_items`, `GET /v1/models`, `GET /v1/models/{model}`. Everything else gets OpenAI's own 404 |
| Fixture | `openai` in Vitest and pytest, `client.openai()` in Rust. A provider, not a channel: it has no people, apps or deliveries |
| Unscripted calls | Answered by a default turn (§8.4), so an agent runs with no script at all |
| Scripts | Belong to the test's session and go away with it, like faults |
| Live mode | The fake model works the same whether the channels are fake or live. "A real Slack sandbox with a deterministic model" becomes possible in the nightly run |

## 4. The interface

### 4.1 The fixture

This sketch is shaped like the generated TypeScript SDK. Most of it comes out of routes as usual. Responders (functions, §6) need one new runtime module and one IR extension (§6.4).

```ts
// what `openai` is in a test's context
export interface OpenAIFixture {
  /** The base URL the agent should use (what `channelstack env` prints as OPENAI_BASE_URL). */
  readonly baseUrl: string;

  /**
   * Script what the model answers. A turn list is used in order, one turn per matching call.
   * A responder (a function) computes each turn from the request. Scripts are tried in the order
   * they were added; the first one that matches and has turns left answers.
   */
  respond(turns: Turn | Turn[], options?: RespondOptions): Promise<ModelScript>;
  respond(responder: Responder, options?: RespondOptions): Promise<ModelScript>;

  /** Every model call attributed to this session, oldest first. */
  calls(query?: ModelCallsQuery): Promise<ModelCall[]>;
  waitForCall(query?: ModelCallsQuery & WaitOptions): Promise<ModelCall>;
  latestCall(query?: ModelCallsQuery & WaitOptions): Promise<ModelCall>;

  /** Calls the server could not attribute to any session (redacted to their shape and matched texts). */
  unattributed(): Promise<UnattributedCall[]>;
}

export interface RespondOptions {
  when?: Match;
  /** How many calls this script answers. Default: the number of turns; unlimited for a responder. */
  times?: number;
  /** Defaults for every turn of this script. */
  timing?: Timing;
}

/** All given fields must hold. Text matches are on normalised text (§8.2) and case-insensitive for strings. */
export interface Match {
  /** The newest user message. */
  text?: string | RegExp;
  /** Anywhere in the request: instructions, history, tool results. */
  prompt?: string | RegExp;
  /** The request offers all these tools. */
  tools?: string[];
  /** The newest input is a tool result (of this tool, with this text). The second step of a tool loop. */
  toolResult?: true | string | { name?: string; text?: string | RegExp };
  endpoint?: "chat.completions" | "responses";
  model?: string | RegExp;
  stream?: boolean;
}
```

### 4.2 A turn: what the model answers

```ts
export type Turn = string | TurnSpec | ErrorTurn;

export interface TurnSpec {
  /** The answer. A string is streamed in chunks of about four characters; an array gives the chunks exactly. */
  text?: string | string[];
  /** Function calls, in order. More than one is a parallel tool call. Ids (`call_…`) are minted by the fake. */
  toolCalls?: { name: string; arguments: Record<string, unknown> | string }[];
  /** Reasoning. Responses: a `reasoning` item with this summary (and `encrypted_content` when the request
   *  includes it). Chat Completions: only `usage.completion_tokens_details.reasoning_tokens`, as OpenAI sends nothing else. */
  reasoning?: { summary?: string | string[]; tokens?: number };
  /** A refusal instead of text (`refusal` on Chat Completions, a `refusal` content part on Responses). */
  refusal?: string;
  /** Default `stop`, or `tool_calls` when there are tool calls. `length` also makes a Responses answer `incomplete`. */
  finish?: "stop" | "length" | "content_filter";
  /** Default: counted from the request and the answer (§10.4). */
  usage?: { input?: number; output?: number; reasoning?: number; cached?: number };
  timing?: Timing;
  /** Break a stream after this many chunks (§7.2). */
  failAfter?: { chunks: number; how?: "drop" | "error" | "stall"; error?: ErrorTurn };
  /** Hold a stream after this many chunks until `script.resume()`: a deterministic "while it streams". */
  pauseAfter?: number;
}

/** An error the API returns instead of an answer. In a turn list it is one call's answer, so the SDK's retries can be scripted. */
export interface ErrorTurn {
  error:
    | "rate_limit"          // 429 rate_limit_exceeded (type "requests" or "tokens"), x-ratelimit-* at 0
    | "slow_down"           // 429 slow_down: a sudden rise in traffic
    | "insufficient_quota"  // 429 insufficient_quota: retrying won't help
    | "server_error"        // 500
    | "overloaded"          // 503 server_is_overloaded
    | "timeout"             // no response until the client gives up (the SDK's timeout, or `after`)
    | "context_length_exceeded" // 400, param "messages" / "input"
    | "content_policy"      // 400 invalid_prompt
    | "unauthorized";       // 401 invalid_api_key
  retryAfter?: Duration;    // sets retry-after and retry-after-ms. Default 0ms, so retry tests stay fast
  shouldRetry?: boolean;    // sets x-should-retry, which the official SDKs obey
  message?: string;
  after?: Duration;         // how long until the error is sent
}

export interface Timing {
  /** From the request's arrival to the response headers and the first chunk (the whole body if not streaming). */
  firstToken?: Duration;
  /** Between chunks of a stream. */
  betweenChunks?: Duration;
}
```

### 4.3 The script handle

```ts
export interface ModelScript extends AsyncDisposable {
  readonly id: string;
  /** The calls this script answered. */
  calls(): Promise<ModelCall[]>;
  waitForCall(options?: WaitOptions): Promise<ModelCall>;
  /** Waits until a stream reached `pauseAfter` and is held. */
  waitForPause(options?: WaitOptions): Promise<ModelCall>;
  /** Lets a held stream go on. */
  resume(): Promise<void>;
  /** Removes the script. Closing the session does it too. */
  undo(): Promise<void>;
  /** Problems with the script found while answering (§5.4): a tool that wasn't offered, arguments the schema refuses. */
  problems(): Promise<string[]>;
}
```

### 4.4 A call, as a test reads it

```ts
export interface ModelCall {
  id: string;                    // the response's own id: chatcmpl-… or resp_…
  endpoint: "chat.completions" | "responses";
  model: string;
  stream: boolean;
  at: string;
  durationMs: number;
  /** 0 for a first try; the SDK's retry number from `x-stainless-retry-count`, when it sends one. */
  attempt: number;
  request: ModelRequest;
  response: {
    status: number;
    text?: string;
    toolCalls?: { id: string; name: string; arguments: unknown }[];
    finish?: string;
    error?: string;              // the error code sent, if any
    /** The agent hung up before the answer was complete: it cancelled the request (Stop) or timed out. */
    aborted?: boolean;
    chunksSent?: number;
  };
  /** Which script answered; none for the default turn. */
  script?: string;
  /** How the call was attributed to this session (§8). */
  attributedBy: "minted_id" | "tag" | "owned_id" | "text";
}

/** The request, normalised: the same shape for both endpoints. */
export interface ModelRequest {
  endpoint: "chat.completions" | "responses";
  model: string;
  stream: boolean;
  /** System and developer messages, and Responses' `instructions`, joined. */
  instructions?: string;
  /** The conversation, oldest first. On Responses it includes what `previous_response_id` chains to. */
  messages: ModelMessage[];
  tools: { name: string; description?: string; parameters?: object; strict?: boolean }[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  responseFormat?: { type: "text" } | { type: "json_object" } | { type: "json_schema"; name: string; schema: object; strict?: boolean };
  reasoning?: { effort?: string; summary?: string };
  /** Shortcuts. */
  lastUserText?: string;
  lastToolResults: { callId: string; name?: string; text: string }[];
  /** The body exactly as sent, and its headers with `Authorization` removed. */
  body: unknown;
  headers: Record<string, string>;
}

export type ModelMessage =
  | { role: "system" | "developer"; text: string }
  | { role: "user"; text: string; images: number; files: number }
  | { role: "assistant"; text?: string; toolCalls: { id: string; name: string; arguments: unknown }[] }
  | { role: "tool"; callId: string; name?: string; text: string };
```

### 4.5 Matchers

Like every matcher, they run in the test process, poll a read method, and negative ones wait for quiet.

| Matcher | On | Holds when |
|---|---|---|
| `toHaveReceivedCall(endpoint?, { times?, text?, error? })` | `openai` | The session has such calls. It's the name Slack's fixture already uses for its own calls |
| `toHaveSent(text \| RegExp \| handle \| handle[], { ordered? })` | a call, or `openai` (any call of the session) | The request contains the text. A handle is a channel message, comment or email: its text, normalised. An array must appear in that order (thread history). `not.toHaveSent(privateMsg)` is the leak check |
| `toHaveSentSecrets()` (used as `not.`) | a call, or `openai` | Any secret channelstack knows appears in the request: a fake or live token, signing secret, webhook secret, private key or refresh token, and the model's own API key in the body |
| `toHaveOfferedTool(name, { schema? })` | a call | The request offers the tool (with a matching JSON Schema) |
| `toBeAborted()` | a call | The agent hung up before the answer finished |
| `toHaveAnswered({ times? })` | a script | The script answered calls |

## 5. Scripting what the model answers

### 5.1 Text and streams

```ts
await openai.respond("Two incidents yesterday: the web deploy and a DNS blip.");
await openai.respond({ text: ["Two incidents", " yesterday", ": web", " and DNS."], timing: { betweenChunks: "200ms" } });
```

**When a list runs out.** A script that has used up its turns no longer matches, and the call goes to the next script, or to the default turn (§8.4). It is recorded on the script ("ms_2 ran out after 2 turns; call 3 got the default"), and a failing matcher's message shows it. Unlike `fakeModel`, running out doesn't throw inside the agent's request, and unlike the AI SDK's mock it isn't silent.

The same turn serves both endpoints, streamed or not. The agent's request decides the wire format: a `chat.completion` object or `chat.completion.chunk` events ending in `data: [DONE]`, a `response` object, or the Responses event sequence. The usage chunk is sent when `stream_options.include_usage` asks for it, and the `obfuscation` field unless `include_obfuscation: false` turns it off. Tool-call arguments stream in pieces split only between JSON tokens, so every prefix stays safe for the partial-JSON parsers agents use.

### 5.2 Tool calls

```ts
await openai.respond([
  { toolCalls: [{ name: "search_incidents", arguments: { since: "yesterday" } }] },
  "Two incidents: the web deploy and a DNS blip.",
]);
```

The first call gets a tool call, and the agent runs the tool and calls again with the result. The second call matches the same script's next turn, because the follow-up request carries the tool call id the fake minted, so it is attributed to the same session (§8). To keep the steps apart explicitly: `when: { toolResult: "search_incidents" }`.

### 5.3 Reasoning

```ts
await openai.respond({ reasoning: { summary: "Looking at the incident log.", tokens: 320 }, text: "Two incidents." });
```

On Responses this is a `reasoning` item, streamed as `response.reasoning_summary_text.delta` events, with an opaque `encrypted_content` when `include: ["reasoning.encrypted_content"]` asks for it. The agent can send that back next turn, and the fake accepts only its own blobs, like the real API. On Chat Completions only the token count shows up.

### 5.4 Checks on the script itself

A script that couldn't happen on the real API is a test bug. So the fake doesn't send it, and it records the reason on the script instead (`problems()`, and in the failure message of any matcher that waits on the agent):

- a tool call names a tool the request didn't offer, or `tool_choice: "none"` forbids it;
- arguments don't validate against the tool's schema when the tool is `strict`;
- text that isn't valid JSON for `response_format: json_object`, or that the strict JSON schema refuses.

The agent then gets the default turn, so the test fails on the agent's behaviour with the script's problem in the message ("script ms_3 called `deploy`, but the request offered `search_incidents`").

## 6. Responses computed from the request

The maintainer wants what LangChain's `fakeModel` gives: a response that is a function of the request (the conversation so far, the tools offered), not only a fixed list.

```ts
await openai.respond((request) => {
  if (request.lastToolResults.length) return `Found: ${request.lastToolResults[0].text}`;
  if (request.tools.some((t) => t.name === "search_incidents"))
    return { toolCalls: [{ name: "search_incidents", arguments: { query: request.lastUserText } }] };
  return `You asked: ${request.lastUserText}`;
});
```

The difficulty: the function lives in the test process (Vitest, pytest, a Rust test), and the request arrives at the server from the agent, a third process.

### 6.1 The options

| | How it works | For | Against |
|---|---|---|---|
| **A. The test answers** | The server holds the agent's request open and passes the normalised request to the SDK, which runs the function and posts the turn back | The full language: closures over test state, `expect` inside, any library. Works the same in TypeScript, Python and Rust. Nothing to sandbox | One round trip per call (a few ms on loopback). The test must stay alive while the agent runs, which it does: it is awaiting a matcher. It needs a channel from server to SDK |
| **B. Rules in the server** | A small declarative language: match, then a template (`"You asked: {lastUserText}"`) | No round trip. Works from the CLI, the UI, MCP and the checks, where no test function exists | Another little language that always lacks one feature. Not what "a function of the request" means |
| **C. Code shipped to the server** | `fn.toString()` evaluated in Bun | No round trip | Closures don't survive serialisation, Python and Rust can't ship JavaScript, and the control API would run arbitrary code. Rejected |

**Recommendation: A for functions, plus a small part of B,** templates only, for where there is no test process: the CLI, UI, MCP and the checks.

### 6.2 How A works

The model call is held, not answered, until the test answers it. The server-to-SDK channel is a **long poll**, not a WebSocket. Each SDK's transport already does plain HTTP with cursors, and the waiting module already polls. Python and Rust get no new dependency.

```
agent ──POST /v1/responses──────────────────────────► server: attributed to ses_1, script ms_4 is a responder
                                                         holds the request, queues it for ms_4
test SDK ──GET  /_channelstack/sessions/ses_1/openai/scripts/ms_4/requests?cursor=…&wait=25s ──► returns it
test SDK    runs the function (the ModelRequest of §4.4)
test SDK ──POST /_channelstack/sessions/ses_1/openai/scripts/ms_4/requests/{req}/answer  { turn } ──► server
server   ──streams the turn, with its timing──────────► agent
```

- **The SDK starts the loop when the responder is registered** and stops it on `undo()`, on dispose, or when the session closes. In TypeScript it's a background promise; Python an `asyncio` task on the session's loop; Rust a `tokio` task holding a `Fn(ModelRequest) -> impl Future<Output = Turn>`.
- **A function that throws** makes the call get a 500 `server_error`, and the error is stored on the script. The next matcher that waits fails with it ("the responder for ms_4 threw: …"), so a bug in the test reads as a bug in the test.
- **No answer within `answerTimeout`** (default: the waits' `timeout`, 10s): the same, with "the test didn't answer". That's a test that ended without closing its session, or a blocked event loop.
- **Timing still holds.** `firstToken` counts from the request's arrival, and the time the function took is part of it. A function slower than `firstToken` delays the answer by that much, and the call records how long the test took.
- **Quiet.** A held call is a provider call in flight, so the session isn't quiet (the quiet detector already counts those).

### 6.3 Templates, for where there is no function

A turn's text can name parts of the request: `{lastUserText}`, `{toolResult}` (the newest result), `{toolResult.search_incidents}`, `{model}`, `{call}` (this script's call number). `{schema}` as the whole text gives the smallest instance that validates against `response_format`'s schema. That's all; anything more is a function.

```bash
channelstack openai respond "You asked: {lastUserText}"            # the dev session, from the CLI
channelstack openai respond --tool search_incidents '{"q":"{lastUserText}"}' --then "Done."
```

### 6.4 What the generator needs

Today the IR has methods, factories and waits, but no callbacks. Responders add:

- an extension on the registering route, `x-channelstack-responder: { requests, answer }`. It names the long-poll route and the answer route, so each emitter generates an overload taking a function, and the routes themselves stay unexposed;
- a hand-written runtime module per language, `responder`. It's the loop of §6.2, mirrored in TypeScript, Python and Rust (code-map rule 4), built on the existing `wait` and transport.

## 7. Timing and failures

### 7.1 Timing

`timing.firstToken` and `timing.betweenChunks`, per script or per turn. A long `firstToken` is the slow model; Slack's retry does the rest.

### 7.2 A stream that breaks

`failAfter: { chunks: n, how }`, after `n` chunks:

| `how` | Chat Completions | Responses |
|---|---|---|
| `"error"` (default) | a `data: {"error": {...}}` event, which the SDK throws on, and the connection closes without `[DONE]` | an `error` event, then `response.failed` |
| `"drop"` | the connection is reset: no terminal event | the same |
| `"stall"` | nothing more is sent until the agent hangs up. That tests the agent's own timeout. The call stays in flight, so the session isn't quiet until the agent gives up; matchers report "Still open: a model stream that stalled after 3 chunks" | the same |

### 7.3 Errors and retries

An error turn is one call's answer, so the official SDKs' retries can be scripted exactly. They retry 408, 409, 429 and 5xx twice by default, and obey `x-should-retry`, `retry-after-ms` and `retry-after`:

```ts
await openai.respond([{ error: "overloaded" }, { error: "overloaded" }, "Done."]);   // the SDK's two retries, then an answer
await openai.respond({ error: "rate_limit", retryAfter: "2s" });                   // every matching call, until undone
await openai.respond({ error: "insufficient_quota" }, { times: Infinity });         // retrying never helps
```

The SDKs honour `retry-after` only up to 60s (Node) or 120s (Python). The fake sends what the script says, so a longer value tests the agent's own handling.

Every response carries OpenAI's headers: `x-request-id` (`req_…`), `openai-processing-ms`, `openai-version`, and the six `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`. A `rate_limit` error sets `remaining` to 0 and `reset` from `retryAfter`, and its message has the form the live API sends ("Rate limit reached for gpt-… in organization org-… on tokens per min (TPM): Limit …, Used …, Requested …. Please try again in 1.2s."). OpenAI's docs don't show that message or the error body, so the nightly shape lane (§10.5) is what confirms them.

### 7.4 What isn't scripted per call

A stateful rate limiter (N requests a minute across calls) isn't in the first version. A list of error turns covers what tests need. See the open questions.

## 8. Matching a model call to a test's session

A model request carries no session. The agent was configured once, with one key and one base URL, and parallel tests share it. Yet the server must decide, when the request arrives, whose script answers, whose `calls()` it appears in, and whose quiet it holds up.

### 8.1 The evidence, strongest first

1. **Ids the fake minted.** A follow-up in a tool loop carries `call_…` ids from an earlier answer. A Responses call can name `previous_response_id`, or send back `encrypted_content` or output item ids. They all point to the earlier call, and so to its session. This decides every call after the first in a run.
2. **A tag the agent chose to send.** `user`, `safety_identifier`, `prompt_cache_key`, `metadata.*`, or an `x-channelstack-session` header, holding a session id or any id the session owns. Agents often set `user` to the Slack user id already. Nothing requires it.
3. **Ids and names the session owns,** found in the request's text: a Slack user or channel id, a channel's generated name (`test-k3f9`), a GitHub issue URL, a Linear identifier, an email's `Message-ID`. Generated per session, they never collide.
4. **Text the session's people wrote.** Every `say`, `reply`, `comment` and `send` in the session is remembered for this. The newest user message's normalised text (§8.2) is looked up among them. One session wins if only it has that text, or if its match is the longest.

The first piece of evidence that decides gives the answer, and the call records which one (`attributedBy`).

### 8.2 Normalising text

People's text and the agent's prompt rarely match byte for byte. The agent strips `<@U08B5K2M9QX>`, resolves it to a name, trims or adds a prefix. Both sides are normalised before comparing: mentions and links are removed, whitespace is collapsed, case is ignored. Then the authored text must appear inside the prompt. Fragments shorter than 8 characters don't count as evidence ("hi" decides nothing).

### 8.3 When two sessions said the same thing

Parallel tests often send identical prompts: every `slackChecks` test says `@my-agent hello`. Text then can't decide. The rule:

- **If the tied sessions' scripts would give the same answer** (none of them scripts a match, or the same turn), the oldest unanswered message wins. Which identical test gets which identical answer changes nothing.
- **Otherwise the call is ambiguous.** It gets the default turn. It is recorded in every tied session as ambiguous, and the next matcher that waits in those sessions fails with the reason: "a model call was ambiguous between this session and 1 other: both sent '@my-agent hello'. Give the prompt something unique, or have the agent send `user`."

Ambiguity is loud, never a silent wrong answer. In practice it's rare: a test that scripts the model almost always says something of its own, and the checks (§12.5) put a unique token in their prompts.

### 8.4 When nothing matches

No session's evidence fits. Examples: an agent that calls the model at startup, a scheduled job, a prompt rewritten past recognition.

- **It gets the default turn:** a successful, short, plainly fake answer, `This is channelstack's fake model. No script matched this request.`, streamed if asked, with no tool calls. An unmodified agent with no scripts at all still works end to end.
- **It's on record in the world scope.** `openai.unattributed()` in any session, `channelstack tail`, and the UI's model inspector show it, as its shape plus what was compared.
- **Strict mode:** `CHANNELSTACK_OPENAI_UNMATCHED=error` answers it with a 400 instead, for suites that want every call scripted. The error message names the newest user text and the tools offered, and shows the `openai.respond(…, { when })` that would have matched (emulate's `strict` does the same).

### 8.5 Alternatives considered

| | Why not alone |
|---|---|
| A key or base URL per session | The agent is configured once per server; that's a settled decision |
| Requiring a header or `user` (aimock's `X-Test-Id`, OpenClaw's `client_metadata.session_id`) | Asks every agent to change; it stays an optional strong signal (8.1, 2) |
| One server per test (emulate) | The agent is one process with one base URL |
| Timing ("the session whose delivery is in flight") | In parallel runs many are in flight. It can't decide, and it would make attribution flaky |
| Injecting a marker into people's text | Changes what the test wrote, and the agent may answer the marker |

## 9. Reading and asserting what the agent sent

```ts
const call = await openai.latestCall({ endpoint: "responses" });
await expect(call).toHaveSent([first, second, third], { ordered: true });   // the thread history, in order
await expect(openai).not.toHaveSent(secretInPrivateChannel);                 // no text from a channel it shouldn't read
await expect(openai).not.toHaveSentSecrets();                                // no tokens, signing secrets, keys
await expect(call).toHaveOfferedTool("search_incidents");
```

- **`calls()` is the session's.** Every call attributed to it, with the normalised request and the response summary, in the event log like every other API call (`readCalls`, `recordCall`).
- **Redaction.** Recorded requests keep the agent's text, because asserting on it is the point. Headers drop `Authorization`. Secrets channelstack knows are redacted in logs and the UI as everywhere (`pnpm test:redaction`). The `toHaveSentSecrets` matcher runs in the server against the raw body before redaction, and returns only which kind of secret it found, never the value.

## 10. Wire fidelity

### 10.1 What the fake serves

- **Chat Completions:** `messages` with every role, text and image and file parts (counted, not read), `tools` with `strict`, `tool_choice`, `parallel_tool_calls`, `response_format` (`json_object`, `json_schema`), `stream` and `stream_options.include_usage`, `max_completion_tokens` (a turn longer than it ends with `finish_reason: "length"`), `n: 1`, `store` (no effect), `metadata`, `user`, `safety_identifier`.
- **Responses:** `input` as a string or items (messages, `function_call`, `function_call_output`, `reasoning`), `instructions`, `tools` (functions), `tool_choice`, `text.format`, `reasoning`, `include`, `store` (default true: stored responses serve `GET /v1/responses/{id}` and `previous_response_id`), `max_output_tokens` (`incomplete` with its reason), `background: false`, every streaming event with its `sequence_number`.
- **Models:** `GET /v1/models` lists current OpenAI model ids.

### 10.2 What it refuses, as OpenAI does

A missing `model` or `messages`, an unknown role, a `tool` message whose `tool_call_id` doesn't answer a call, `previous_response_id` that doesn't exist (`previous_response_not_found`), `n > 1` with tools, `json_schema` without `name`, an `X-Client-Request-Id` that isn't ASCII or is over 512 characters, and a missing or wrong key (401 `invalid_api_key`). Unknown tool types and unknown fields are recorded on the call rather than refused, unless OpenAI documents a refusal. emulate's refusal of Codex's `namespace` tools (#436) shows the cost of guessing. Each uses OpenAI's error body `{ error: { message, type, param, code } }`.

### 10.3 Not in the first version

Built-in tools (`web_search`, `file_search`, `code_interpreter`, `computer_use`, remote MCP): they are refused with OpenAI's 400 for an unsupported tool, and listed in the reality matrix. Also out: background responses, the Conversations API, the Assistants API, Realtime, audio, images, files, batches and `n > 1`. Embeddings are open question 7. Each gap is a line in the open questions, not a silent omission.

### 10.4 Ids and numbers

Ids look like OpenAI's: `chatcmpl-` and 29 base-62 characters, `resp_`/`msg_`/`fc_`/`rs_` and 48 hex characters, `call_` and 24, `req_` and 32, `fp_` and 10 for `system_fingerprint`, from the world's seeded random source, like every fake id. Usage is counted as about four characters a token, so numbers grow with the prompt and `context_length_exceeded` can be triggered by length (open question: a real tokenizer).

### 10.5 Keeping it honest

As with the channels:

- every response and stream event the fake sends is checked against OpenAI's published OpenAPI description, pinned like Resend's and Gmail's (`scripts/pinned-schema.ts`, `server/test/schemas/`);
- the official `openai` SDKs (Node and Python) are the conformance clients in the fake's tests;
- a nightly lane sends a fixed set of requests to the real API with a cheap model, and diffs the response and event **shapes** against the fake's (the proxy's `shapeOf`). Shapes, not content.

## 11. What it covers for free

Anything that speaks OpenAI's wire format and takes a base URL:

| | How it points at the fake |
|---|---|
| `openai` (Node, Python), `async-openai` (Rust), `go-openai` | `OPENAI_BASE_URL`, which the official SDKs read by themselves |
| AI SDK `@ai-sdk/openai` (Responses by default) and `@ai-sdk/openai-compatible` (Chat Completions) | `createOpenAI({ baseURL })`, or the environment |
| LangChain `ChatOpenAI` (JS and Python; `useResponsesApi`) | `configuration.baseURL` / `base_url`, or the environment |
| OpenAI Agents SDK (JS and Python) | `OPENAI_BASE_URL`, or `setDefaultOpenAIClient` |
| Mastra, Pi (`pi-ai`), LlamaIndex, pydantic-ai, CrewAI and LiteLLM as clients | their OpenAI provider's base URL |
| Agents that use a gateway: OpenRouter, Vercel AI Gateway, LiteLLM proxy, Cloudflare AI Gateway, Groq, Together, Fireworks, DeepSeek, xAI, Mistral, Ollama, vLLM, LM Studio, Azure OpenAI's v1 API, Gemini's OpenAI-compatible endpoint | the gateway's base URL replaced with the fake's. The fake answers any model name (`openai/gpt-…`, `llama-3.3-70b`) |

Gateway-specific extensions (OpenRouter's `reasoning` field, DeepSeek's `reasoning_content`, Azure's `/openai/deployments/{d}/…?api-version=` paths) aren't served in the first version.

## 12. Where else it appears

### 12.1 `channelstack env`

```bash
OPENAI_BASE_URL=https://openai.localhost/v1
OPENAI_API_KEY=sk-proj-…
```

`env --no-model` leaves them out, for an agent that should use the real API while the channels are fake.

### 12.2 CLI, MCP and UI

- `channelstack openai respond …` (templates, §6.3), `channelstack openai calls`, and model calls in `channelstack tail`, all in the dev session.
- MCP gets `openai_respond` and `openai_calls`, generated like the other actions.
- The UI gets a **Models** inspector: each call's normalised conversation, the session and evidence it was attributed by, the script that answered, timing, and the raw events.

### 12.3 Proxy mode

`api.openai.com` joins the routed hosts **only with `--fake-models`**. Otherwise proxy mode passes it through, because an agent behind the proxy may mean to use the real model with fake channels. With it, nothing reaches the real API: OpenClaw's "fail if any call reaches the real provider host" for free.

### 12.4 Python and Rust

```python
async def test_tool_loop(slack, openai):
    ana = await slack.create_user(name="Ana")
    await openai.respond([
        Turn(tool_calls=[ToolCall("search_incidents", {"since": "yesterday"})]),
        "Two incidents: the web deploy and a DNS blip.",
    ])

    async def answer(request: ModelRequest) -> Turn:   # a responder is any callable, sync or async
        return Turn(text=f"You asked: {request.last_user_text}")
    await openai.respond(answer, when=Match(text="what's new"))

    msg = await ana.say("what broke yesterday?", to=slack.app)
    await expect(msg.thread).to_have_reply_from("my-agent", text=re.compile("DNS"))
    await expect(openai).not_to_have_sent_secrets()
```

```rust
let openai = client.openai(&session);
openai.respond(vec![
    Turn::tool_call("search_incidents", json!({ "since": "yesterday" })),
    Turn::text("Two incidents: the web deploy and a DNS blip."),
]).await?;
openai.respond_with(|req: ModelRequest| async move { Turn::text(format!("You asked: {}", req.last_user_text())) })
    .when(Match::text("what's new")).await?;
expect(&openai).not_to_have_sent_secrets().await?;
```

In pytest the fixture is named `openai`, which shadows the `openai` package inside a test that also imports it (open question).

### 12.5 The standard checks, and a check with no tests

Each channel's checks take the model: `slackChecks({ app: "my-agent", model: openai })` (and `model="openai"` in pytest). With it:

- **The checks script the model themselves.** The stream and Stop checks no longer need `streamPrompt`, because the check scripts a long, slow stream. Every check's prompt carries a unique token, so parallel checks never tie (§8.3).
- **New checks, one per model bug class:**

  | Check | What it does | The bug |
  |---|---|---|
  | `<channel>.slow-model` | `firstToken: "5s"`, with the platform's retry (Slack's 3s retry, a GitHub redelivery) | Duplicate replies |
  | `<channel>.model-error` | `overloaded` on every call | Status stuck on "Thinking…", nothing said to the person |
  | `<channel>.model-retry` | two `overloaded`, then an answer | Two replies when the SDK retries |
  | `slack.stream-breaks` | `failAfter: { chunks: 3 }` | A stream never stopped |
  | `slack.stop-cancels-model` | `pauseAfter`, then Stop, then the call must be `aborted` | Stop leaves the model running |
  | `<channel>.no-secrets-to-model` | `not.toHaveSentSecrets()` on every call of every check | Tokens in the prompt |

- **`channelstack check`**, with no test files: `channelstack check slack --app my-agent` runs the same checks against a running agent from the CLI and prints one line per check, then exits non-zero if any failed. With the fake model in the agent's environment, an **unmodified agent with no keys** gets the whole suite in CI:

  ```bash
  npx channelstack start --no-portless --port 4500 &
  npx channelstack env >> "$GITHUB_ENV"         # includes OPENAI_BASE_URL and OPENAI_API_KEY
  pnpm start &                                 # the agent, unchanged
  npx channelstack check slack github --app my-agent
  ```

  The checks are registered with Vitest's `describe` and `test`. So the CLI runs them through Vitest, bundled with the npm package and started on a generated config, rather than through a second runner (open question).

## 13. Example tests

These would go into `test/acceptance/examples/openai.test.ts`, type-checked against the generated SDK like the others, and run against a reference agent that uses the official `openai` SDK (and a second one on the AI SDK, which uses Responses).

```ts
/**
 * OpenAI examples. The agent uses the official `openai` SDK with OPENAI_BASE_URL from `channelstack env`.
 * Every test scripts the model; none needs a key.
 */
import { describe, expect, test } from "vitest";

describe("scripting the model", () => {
  test("a tool loop ends in one answer, in the thread", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    const script = await openai.respond([
      { toolCalls: [{ name: "search_incidents", arguments: { since: "yesterday" } }] },
      "Two incidents yesterday: the web deploy and a DNS blip.",
    ]);

    const msg = await ana.say("@my-agent what broke yesterday?", { channel });

    await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /DNS blip/ });
    await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
    await expect(script).toHaveAnswered({ times: 2 });
    const [, second] = await script.calls();
    expect(second.request.lastToolResults[0]?.name).toBe("search_incidents");
  });

  test("the answer is computed from what the agent sent", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    await openai.respond((request) =>
      `I can see ${request.messages.filter((m) => m.role === "user").length} messages from you.`,
    );

    const msg = await ana.say("@my-agent the deploy failed", { channel });
    await msg.thread.waitForReply({ from: "my-agent" });
    await ana.reply("it's the migration step", { thread: msg });

    // The second answer proves the agent sent the whole thread, not only the newest message.
    await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /2 messages/ });
  });
});

describe("timing and failures (fake only)", () => {
  test("a slow model and Slack's 3s retry still give one reply", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    await openai.respond("Here's the summary.", { timing: { firstToken: "5s" } });

    const msg = await ana.say("summarize #support today", { to: slack.app });
    await msg.delivery!.retry({ after: "3s", reason: "http_timeout" });

    await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1, timeout: "15s" });
    await expect(openai).toHaveReceivedCall("chat.completions", { times: 1 });
  });

  test("a stream that breaks halfway is finalised, and the status clears", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    await openai.respond({
      text: ["The deploy", " failed at", " the migration", " step because"],
      timing: { betweenChunks: "100ms" },
      failAfter: { chunks: 2, how: "drop" },
    });

    const msg = await ana.say("why did the deploy fail?", { to: slack.app });

    await expect(msg.thread).toHaveStatus("idle");
    await expect(msg.thread).not.toHaveStreamingReplyFrom("my-agent");
    await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /deploy failed at/ });
  });

  test("overloaded twice: the SDK retries, and the person gets one answer", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    await openai.respond([{ error: "overloaded" }, { error: "overloaded" }, "All good now."]);

    const msg = await ana.say("status?", { to: slack.app });

    await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
    await expect(openai).toHaveReceivedCall("chat.completions", { times: 3 });
  });

  test("Stop cancels the model request", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const script = await openai.respond({ text: "A long answer ".repeat(40), pauseAfter: 3 });

    const msg = await ana.say("write me a long report", { to: slack.app });
    const call = await script.waitForPause();
    await ana.stop({ thread: msg });

    await expect(msg.thread).toHaveStatus("stopped");
    await expect(call).toBeAborted();
  });
});

describe("what the agent sends the model", () => {
  test("thread history, no private-channel text, no secrets", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const ben = await slack.createUser({ name: "Ben" });
    const secret = await slack.createChannel({ private: true, participants: [ben, slack.app] });
    const leak = await ben.say("the acquisition closes on Friday", { channel: secret });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    await openai.respond("Noted.");

    const first = await ana.say("@my-agent the deploy failed", { channel });
    await first.thread.waitForReply({ from: "my-agent" });
    const second = await ana.reply("it's the migration step", { thread: first });

    const call = await openai.latestCall();
    await expect(call).toHaveSent([first, second], { ordered: true });
    await expect(openai).not.toHaveSent(leak);
    await expect(openai).not.toHaveSentSecrets();
  });
});
```

## 14. How it fits the code

New pieces, each a row in [code-map.md](../../docs/code-map.md) when built:

| Piece | Where | Builds on |
|---|---|---|
| The provider | `server/src/providers/openai/` (a new kind next to `drivers/`: no people, apps, deliveries or transcripts) | `fake/endpoint.ts`'s `restApi` (auth, bodies, refusals in the platform's shape, call recording); ids from the world's random source; `secrets` for the key |
| SSE writer with timing, pause, break | `server/src/core/stream/` | the injected clock and timers |
| Attribution | `server/src/core/attribution/`: what each session's people wrote and the ids it owns, looked up per request | the event log (people's actions are already on it); the object registry |
| Scripts, responders, templates | `server/src/providers/openai/scripts.ts` | session lifetime, like faults |
| Routes | `providers/openai/routes.ts`: `respond`, `calls`, `unattributed`, the responder's `requests` and `answer` | `registerRoute`, `readCalls`, `recordCall` |
| SDK runtime | `responder` in each SDK runtime | `wait`, transport |
| Matchers | `integrations/matchers-core/` (and pytest's and Rust's counterparts) | the read methods |
| Checks | `integrations/checks/`: the model checks of §12.5 | public API only |

It needs a few decisions in code. `check:channels` must not treat a provider as a channel. The quiet detector must count a held or stalled model call. The redaction check must learn the OpenAI key's `sk-proj-` prefix.

Dependencies: none new in the server for the protocol. JSON Schema validation of tool arguments and structured output needs a validator (Ajv, MIT, pure JS) unless Zod 4's JSON Schema support is enough. The official `openai` package becomes a dev dependency for conformance tests and the reference agent.

## 15. Open questions for the maintainer

1. **The fixture's name.** `openai`, like `slack`, one fixture per host. The alternative is a provider-neutral `model` fixture whose scripts answer on whichever wire format the agent uses (OpenAI now, Anthropic later). Pytest's `openai` shadows the package. *Default: `openai` in every language.*
2. **The default turn for unscripted calls.** A fixed, plainly fake text (proposed), an echo of the newest user message (friendlier for demos, but it makes `text:` matchers pass by accident), or an error. *Default: the fixed text, `CHANNELSTACK_OPENAI_UNMATCHED=error` for strict suites.*
3. **Ambiguous calls (§8.3).** Fail the tied tests loudly (proposed), or always give the oldest unanswered message the call. *Default: loud.*
4. **Unknown model names.** Accept any name (proposed: gateways use their own, and a fake that refuses `llama-3.3-70b` helps nobody), or refuse names not in `/v1/models` with 404 `model_not_found`, like OpenAI. *Default: accept any; record a note on the call.*
5. **Tokenizer.** About four characters a token (proposed), or a real tokenizer (`js-tiktoken`, MIT, pure JS, about 1 MB of ranks in the binary) for exact `usage` and `context_length_exceeded`. *Default: the estimate.*
6. **A stateful rate limiter** (`openai.rateLimit({ requestsPerMinute })`) on top of error turns. *Default: not in the first version.*
7. **Built-in tools** (web search, file search, remote MCP), **embeddings** and the **Conversations API**. Which, if any, belong in the first version? emulate and OpenClaw both serve deterministic embedding vectors, which is cheap and helps RAG agents. *Default: embeddings yes (deterministic vectors from a hash of the text); the rest refused with OpenAI's errors.*
8. **Gateway dialects:** OpenRouter's `reasoning`, DeepSeek's `reasoning_content`, Azure's deployment paths. *Default: none in the first version.*
9. **Proxy mode routing `api.openai.com`** only with `--fake-models` (proposed), or always. *Default: opt-in.*
10. **`channelstack check` running Vitest** under the hood, rather than a runner of its own. *Default: Vitest, bundled.*
11. **Where it goes in the phase plan.** After phase 12 (multiple apps) as phase 13, or before it, since it's independent of apps. And when Anthropic follows: the same phase or the next. *Default: phase 13 for OpenAI, phase 14 for Anthropic.*
12. **The decision record.** It reverses the `AGENTS.md` **Models** row and `devx.md` §6. The next free number is 0028 (0027 is claimed twice already, by #105 and #106). *Written once the interface is approved.*
