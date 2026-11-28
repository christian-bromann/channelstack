# A fake OpenAI: interface draft

> Status: **approved**, 2026-11-27, after three rounds of the maintainer's review (§16 lists what was settled). Recorded as [decision 0029](../../docs/decisions/0029-fake-openai.md), and built in phases 13 and 14 ([phases.md](../../docs/phases.md)). Nothing is built yet.
> Scope: **OpenAI only**: Chat Completions and the Responses API at `https://openai.localhost/v1`. No other model provider is planned.
> It reverses the settled `AGENTS.md` row **Models**: "channelstack doesn't mock LLMs". The new rule: **realistic on the wire, never realistic content.** Answer-quality evals stay out of scope.

## 1. Why

The primary persona ([audience.md](../../docs/audience.md) §1) builds on the raw OpenAI SDK, on the AI SDK, LangChain or Mastra, or on an OpenAI-compatible gateway. Today [devx.md §6](../../docs/devx.md#6-the-model) sends them to their framework's fake model. That fails in three ways:

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
| Host | `https://openai.localhost/v1` (portless); `http://localhost:4500/openai/v1` with `--no-portless`; `api.openai.com` in proxy mode, always, like every routed host (§12.3) |
| `channelstack env` | `OPENAI_BASE_URL=https://openai.localhost/v1`, `OPENAI_API_KEY=sk-proj-…` (random per install, in `secrets.json`, like every fake token) |
| Endpoints | `POST /v1/chat/completions`; `POST /v1/responses`, with `GET`, `DELETE` and `input_items` for stored ones; `POST /v1/images/generations` and `/edits`; `POST /v1/audio/speech`, `/transcriptions` and `/translations`; `/v1/files`; container file downloads; `GET /v1/models`. Everything else gets OpenAI's own 404 (§10.3) |
| Fixture | `openai` in Vitest and pytest, `client.openai()` in Rust. A provider, not a channel: it has no people, apps or deliveries |
| Unscripted calls | Refused, and the test fails with a message saying which `openai.respond(…)` is missing (§8.4) |
| Scripts | Belong to the test's session and go away with it, like faults |
| Live mode | The fake model works the same whether the channels are fake or live. "A real Slack sandbox with a deterministic model" becomes possible in the nightly run |

## 4. The interface

### 4.1 The fixture

This sketch is shaped like the generated TypeScript SDK. Most of it comes out of routes as usual. Responders (functions, §6) need one new runtime module and one IR extension (§6.4).

```ts
export type Endpoint =
  | "chat.completions" | "responses"
  | "images.generations" | "images.edits"
  | "audio.speech" | "audio.transcriptions" | "audio.translations";

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

  /** Every tool call the model made in this session, each with the result the agent sent back (§9.1). */
  toolCalls(query?: { name?: string }): Promise<ModelToolCall[]>;

  /** A rate limit that counts this session's calls and tokens, with truthful x-ratelimit-* headers (§7.4). */
  rateLimit(limits: RateLimits): Promise<ModelRateLimit>;

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
  endpoint?: Endpoint;
  model?: string | RegExp;
  stream?: boolean;
  /** The call answers this person's message, or one in this conversation or thread (its context, §8.6). */
  from?: ChannelPerson;
  in?: ChannelPlace | ChannelThread;
  /** The newest input is an MCP approval response, approving (true) or not (false) (§5.6). */
  approval?: boolean;
}
```

### 4.2 A turn: what the model answers

```ts
export type Turn = string | TurnSpec | ErrorTurn;

export interface TurnSpec {
  /** The answer. A string is streamed in chunks of about four characters; an array gives the chunks exactly. */
  text?: string | string[];
  /** Tool calls, in order: functions, or OpenAI's built-in tools (§5.6). More than one is a parallel call. Ids are minted by the fake. */
  toolCalls?: ToolCallSpec[];
  /** Citations on the text (after a web or file search): each marks the first occurrence of `quote`. */
  citations?: { quote: string; url?: string; title?: string; file?: string }[];
  /** An image: the Images API's answer (§5.5). */
  image?: MediaSource | MediaSource[];
  /** Audio: `/v1/audio/speech`, or Chat Completions' audio output with `text` as its transcript (§5.5). */
  audio?: MediaSource;
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
  /** Hold a stream after this many chunks until `ai.resume()`: a deterministic "while it streams". */
  pauseAfter?: number;
}

/** A tool call in an answer. A function by default; the other kinds are OpenAI's built-in tools (§5.6). */
export type ToolCallSpec =
  // the agent runs these and sends the result back
  | { name: string; arguments: Record<string, unknown> | string }                  // a function
  | { custom: string; input: string }                                              // a custom tool: free-form input
  | { computer: { actions: ComputerAction[] } }
  | { shell: { commands: string[]; output?: string } }                             // `output` when the request's shell is hosted
  | { applyPatch: { operations: PatchOperation[] } }                               // create_file, update_file, delete_file
  // OpenAI runs these: their results are part of this same answer, as the script gives them
  | { webSearch: { query: string; sources?: { url: string; title?: string }[] } }
  | { fileSearch: { queries: string[]; results?: { file: string; text: string; score?: number }[] } }
  | { codeInterpreter: { code: string; logs?: string; files?: MediaSource[] } }
  | { imageGeneration: { image: MediaSource; revisedPrompt?: string } }
  | { mcp: { server: string; tool: string; arguments?: Record<string, unknown>; output?: string; error?: string; approval?: boolean } };

/** Media in an answer: a path (read in the test process and uploaded), bytes, or a placeholder the fake makes (a PNG, or WAV/PCM silence). */
export type MediaSource = string | Uint8Array | { placeholder: { width?: number; height?: number; seconds?: number } };

/** An error the API returns instead of an answer. In a turn list it is one call's answer, so the SDK's retries can be scripted. */
export interface ErrorTurn {
  error:
    // 429, retried by the SDKs
    | "rate_limit"                         // "Rate limit reached for requests", x-ratelimit-remaining-* at 0
    | "slow_down"                          // rate_limit_error / slow_down: traffic rose too fast
    // 429, type insufficient_quota: retrying never helps (OpenAI's error-codes guide)
    | "insufficient_quota"
    | "credit_balance_exhausted"           // no prepaid credits left
    | "organization_spend_limit_exceeded"  // the organisation's monthly spend limit
    | "project_spend_limit_exceeded"       // the project's monthly spend limit
    | "organization_usage_limit_exceeded"  // the usage limit OpenAI assigned
    // 5xx, retried
    | "server_error"                       // 500 "The server had an error while processing your request"
    | "overloaded"                         // 503 service_unavailable_error / server_is_overloaded
    | "timeout"                            // no response until the client gives up (the SDK's timeout, or `after`)
    // 4xx, not retried
    | "context_length_exceeded"            // 400, param "messages" / "input"
    | "content_policy"                     // 400 invalid_prompt
    | "invalid_api_key"                    // 401 "Incorrect API key provided"
    | "not_in_organization"                // 401 "You must be a member of an organization to use the API"
    | "ip_not_authorized"                  // 401 "IP not authorized"
    | "unsupported_region";                // 403 "Country, region, or territory not supported"
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
  /** The tool calls this script made, each with the agent's result (§9.1). */
  toolCalls(query?: { name?: string }): Promise<ModelToolCall[]>;
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
  endpoint: Endpoint;
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
  /** The tool calls in this call's answer, each with the result the agent sent back later, if it did. */
  toolCalls: ModelToolCall[];
  /** Which script answered. None when the call was refused for want of one (§8.4). */
  script?: string;
  /** How the call was attributed to this session (§8). */
  attributedBy: "minted_id" | "tag" | "owned_id" | "text" | "order";
}

/** The request, normalised: the same shape for both endpoints. */
export interface ModelRequest {
  endpoint: Endpoint;
  model: string;
  stream: boolean;
  /** Where the call belongs in the channels: the message it answers, its author, the conversation (§8.6). */
  context?: RequestContext;
  /** The Images API's prompt, or the text speech is made from. */
  prompt?: string;
  /** The audio to transcribe, or the image to edit. */
  file?: ModelPart;
  /** System and developer messages, and Responses' `instructions`, joined. */
  instructions?: string;
  /** The conversation, oldest first. On Responses it includes what `previous_response_id` chains to. */
  messages: ModelMessage[];
  /** Functions by name; built-in tools by their type (`web_search`, `mcp`, …) with their settings. */
  tools: { type: string; name?: string; description?: string; parameters?: object; strict?: boolean; settings?: object }[];
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

/** An image, file or audio part the agent sent: identified by its hash, so a test can compare it with what a person shared. */
export type ModelPart =
  | { type: "text"; text: string }
  | { type: "image" | "file" | "audio"; mediaType: string; bytes: number; sha256: string; filename?: string;
      from: "data" | "file_id" | "url"; url?: string };

/** What channelstack knows about a call's place in the channels (§8.6). Handles, like everything a test reads. */
export interface RequestContext {
  channel: string;                       // "slack", "github", …
  message?: ChannelMessage;              // the person's message the call answers, when the evidence names one
  from?: ChannelPerson;
  conversation?: ChannelPlace;           // the channel, DM, issue, PR, page or email thread
  thread?: ChannelThread;
  /** The same text came more than once in the session: every message it could be, newest first. */
  candidates: ChannelMessage[];
}

/** A tool call the model made, joined with the result the agent sent back in a later call. */
export interface ModelToolCall {
  id: string;                    // call_…, or the built-in item's id (ws_…, mcp_…)
  type: "function" | "custom" | "computer" | "shell" | "apply_patch"
      | "web_search" | "file_search" | "code_interpreter" | "image_generation" | "mcp";
  /** OpenAI ran it (a built-in), so `result` is what the script said. Otherwise the agent ran it. */
  hosted: boolean;
  name: string;
  arguments: unknown;            // parsed JSON, or the string if it isn't JSON
  madeIn: string;                // the ModelCall whose answer made it
  result?: { text: string; sentIn: string };   // the ModelCall whose request carried the result
}

export type ModelMessage =
  | { role: "system" | "developer"; text: string }
  | { role: "user"; text: string; parts: ModelPart[] }
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
| `toHaveSentToolResult(name, { text? })` | a script, or `openai` | The agent ran a tool call and sent its result back (with this text) |
| `toHaveSentFile(path \| bytes)` | a call, or `openai` | The request carries this image, file or audio, compared by hash |
| `toBeAborted()` | a call | The agent hung up before the answer finished |
| `toHaveAnswered({ times? })` | a script (`ai`) | The script answered calls |

## 5. Scripting what the model answers

### 5.1 Text and streams

```ts
await openai.respond("Two incidents yesterday: the web deploy and a DNS blip.");
await openai.respond({ text: ["Two incidents", " yesterday", ": web", " and DNS."], timing: { betweenChunks: "200ms" } });
```

**When a list runs out.** A script that has used up its turns no longer matches, and the call goes to the next script, or is refused if none matches (§8.4). It is recorded on the script ("ms_2 ran out after 2 turns; call 3 got the default"), and a failing matcher's message shows it. Unlike `fakeModel`, running out doesn't throw inside the agent's request, and unlike the AI SDK's mock it isn't silent.

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

The agent gets the refusal of §8.4 instead, and the test fails with the script's problem in the message ("script ms_3 called `deploy`, but the request offered `search_incidents`").

### 5.5 Images, audio and files

**What the agent sends.** Image, file and audio parts are read, not just counted. Each is a part of the `ModelRequest` with its media type, size and SHA-256, so a test can check that the agent passed on what a person shared:

```ts
await openai.respond("The stack trace points at the migration.");
await ana.say("@my-agent what's wrong here?", { channel, files: "./fixtures/error.png" });
await expect(await openai.waitForCall()).toHaveSentFile("./fixtures/error.png");   // the same bytes
```

- Data URLs, `file_id`s from `/v1/files` and URLs are all accepted, on Chat Completions (`image_url`, `file`, `input_audio`) and on Responses (`input_image`, `input_file`).
- **A URL on a fake host is fetched the way OpenAI would fetch it: without credentials.** An agent that hands the model Slack's `url_private` gets OpenAI's 400 (`invalid_image_url`, "Error while downloading …"), as it would for real. That's a real bug class: the agent must download the file and send its bytes. A public URL on a fake host works. URLs elsewhere aren't fetched, and are recorded as given.

**What the model answers.** A turn can carry media:

| Endpoint | The turn |
|---|---|
| `images.generations`, `images.edits` | `image` (one, or several for `n`), base64 or a URL as the request asks |
| `audio.speech` | `audio`, in the requested `response_format` |
| `audio.transcriptions`, `audio.translations` | `text`, as JSON, text, SRT or VTT as asked. With `stream: true` it's streamed as transcript deltas, with timing like any stream |
| `chat.completions` with `modalities: ["text", "audio"]` | `audio`, with `text` as its transcript (`message.audio`, `delta.audio` when streaming) |

```ts
await openai.respond({ image: "./fixtures/chart.png" }, { when: { endpoint: "images.generations" } });
await openai.respond({ text: "The deploy fails at the migration step." }, { when: { endpoint: "audio.transcriptions" } });
await openai.respond({ audio: { placeholder: { seconds: 2 } } }, { when: { endpoint: "audio.speech" } });
```

A `MediaSource` is a path, which the SDK reads in the test process and uploads, like a repository's `files:`. It can also be bytes, or a placeholder the fake makes: a PNG of a given size, or WAV or PCM silence of a given length. Other formats (JPEG, WebP, MP3, Opus) need a file. A placeholder in a format the fake can't make is a script problem (§5.4), never a body with the wrong media type.

Video isn't served: OpenAI shut the Videos API (Sora) down on 2026-09-24.

### 5.6 Built-in tools

OpenAI's built-in tools are scripted like functions, in `toolCalls`. The fake never runs anything: no search, no container, no call to an MCP server. What a hosted tool found is what the script says. What a client-run tool did is what the agent sends back.

| Tool (`type`) | Who runs it | In the answer | Scripted as |
|---|---|---|---|
| `web_search` | OpenAI | `web_search_call` (action `search`, `open_page` or `find_in_page`), then the message with `url_citation` annotations | `{ webSearch: { query, sources } }`, with `citations` on the text |
| `file_search` | OpenAI | `file_search_call` (its results when `include` asks), then `file_citation` annotations | `{ fileSearch: { queries, results } }` |
| `code_interpreter` | OpenAI, in a container | `code_interpreter_call` with its code and outputs (logs, images). Files it wrote can be downloaded from the container | `{ codeInterpreter: { code, logs, files } }` |
| `image_generation` | OpenAI | `image_generation_call` with the base64 `result`, and partial images when asked | `{ imageGeneration: { image, revisedPrompt } }` |
| `mcp` (remote MCP) | OpenAI calls the server | `mcp_list_tools`, then `mcp_call`, or an `mcp_approval_request` the agent answers with `mcp_approval_response` | `{ mcp: { server, tool, arguments, output \| error, approval } }` |
| `shell`, hosted | OpenAI | `shell_call` and `shell_call_output` | `{ shell: { commands, output } }` |
| `shell`, `local` | the agent | `shell_call`; the agent sends `shell_call_output` | `{ shell: { commands } }` |
| `computer` | the agent | `computer_call` with its `actions`; the agent sends `computer_call_output` with a screenshot | `{ computer: { actions } }` |
| `apply_patch` | the agent | `apply_patch_call`; the agent sends `apply_patch_call_output` | `{ applyPatch: { operations } }` |
| `custom` | the agent | `custom_tool_call` with free-form `input` | `{ custom: name, input }` |

- **Built-in tools are on Responses only,** as on the real API. On Chat Completions, a search model with `web_search_options` gives the citations and nothing else. Offering a built-in tool on Chat Completions is refused as OpenAI refuses it.
- **A script calls only what the request offered** (§5.4). For `mcp`, the `server` must be the request's `server_label`, and the tool must be in its `allowed_tools`. `vector_store_ids` and container ids are accepted as given.
- **Each tool streams its own events** (`response.web_search_call.searching`, `response.code_interpreter_call_code.delta`, `response.image_generation_call.partial_image`, …), in the order the pinned OpenAPI description gives. OpenAI's guides don't name all of them, so the pinned description is the source.
- **`toolCalls()` lists them all,** with `hosted` saying who ran each.

The MCP approval flow is a channel test of its own. The agent turns the `mcp_approval_request` into an approval button, a person's click becomes the `mcp_approval_response`, and only then does the tool run (§13).

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
- **A function that throws** makes the call get the refusal of §8.4 (a 400, which the SDKs don't retry, so the function isn't run three times), and the error is stored on the script. The next matcher that waits fails with it ("the responder for ms_4 threw: …"), so a bug in the test reads as a bug in the test.
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

### 7.4 A rate limit across calls

Error turns script one call at a time. A rate limit counts:

```ts
export interface RateLimits {
  requests?: { limit: number; per?: Duration };   // default per: "1m"
  tokens?: { limit: number; per?: Duration };     // counted as in §10.4, the request and the answer
  /** What a call over the limit gets. Default "rate_limit". */
  error?: "rate_limit" | "slow_down";
}

export interface ModelRateLimit extends AsyncDisposable {
  /** What the headers would say now. */
  remaining(): Promise<{ requests?: number; tokens?: number; resetsIn?: Duration }>;
  undo(): Promise<void>;
}
```

```ts
await openai.rateLimit({ requests: { limit: 2, per: "10s" } });
await openai.respond("Done.", { times: Infinity });
```

- **It counts this session's calls only.** Real limits are per organisation, but a test must not be throttled by its neighbours.
- **The headers tell the truth** on every response while a limit is set: `x-ratelimit-limit-*`, `-remaining-*`, and `-reset-*` as Go-style durations (`1s`, `6m0s`). A call over the limit gets the 429 with `retry-after` and `retry-after-ms` set to when a slot frees up. Without a limit, the headers show a generous fixed tier, so an agent that reads them sees plausible numbers.
- **It runs on the server's clock,** the one the fakes already inject, so a test doesn't wait a real minute for a reset when the clock is controlled.
- **Plan and spend limits aren't counted:** they don't reset, so they are error turns (`{ error: "project_spend_limit_exceeded" }`, with `times: Infinity`).

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

### 8.3 When two tests sent the same text

Two tests run at the same time, both have a person say `@my-agent hello`, and the model call carries nothing else that tells them apart. That has to be designed out by the test, like any parallel tests that share something:

- **The call goes to the session of the oldest unanswered message,** and is recorded as attributed by order (`attributedBy: "order"`).
- **If that hands a test the other's answer,** the failing matcher's message says so: "this reply's model call was attributed by order, between 2 sessions that both sent '@my-agent hello'. Give each test's prompt something of its own, or have the agent send `user`."
- **The docs say so** wherever they show a scripted model, and the checks (§12.5) put a unique token in every prompt.

### 8.4 When nothing matches

There is no default answer: a model call with no script to answer it is a mistake in the test, and it fails loudly. That covers three cases: the test's session has no `openai.respond(…)` whose `when` fits, the session has none at all, or the call can't be attributed to a session.

**What the agent gets:** a 400, so the SDKs don't retry it:

```json
{ "error": { "type": "invalid_request_error", "code": "channelstack_no_script", "param": null,
  "message": "channelstack: no openai.respond(…) in this test answers this call. Newest user message: \"what broke yesterday?\". Tools offered: search_incidents. For example: openai.respond(\"…\", { when: { text: \"what broke yesterday?\" } })" } }
```

**How the test fails,** when the call was attributed to its session:

- **At once, in any matcher or wait that is running.** Each poll also reads the session's model problems, so `toHaveReplyFrom` fails right away with the same message instead of timing out ten seconds later. The same goes for a script problem (§5.4), a responder that threw, or a static list that ran out (§8.6).
- **At the latest, when the session closes,** even if the test asserts nothing about the model: the Vitest fixture fails the test, pytest's fixture raises in teardown, and Rust's `session.close()` returns the error.

**A call no session claims** (the agent calls the model at startup or from a scheduled job, or rewrites the prompt past recognition) gets the same 400. No test can be blamed for it, so it's recorded in the world scope: `openai.unattributed()` in any session, `channelstack tail`, and the UI's model inspector show its shape and what was compared. Any test whose matcher fails while it's there gets a line saying so ("1 model call in the last 10s couldn't be attributed to a test: 'summarise the backlog…'").

**The dev session too:** the CLI and the UI script it with `channelstack openai respond …` (§6.3). An agent driven from the UI with no script gets the same refusal, and the UI shows it on the conversation.

### 8.5 Alternatives considered

| | Why not alone |
|---|---|
| A key or base URL per session | The agent is configured once per server; that's a settled decision |
| Requiring a header or `user` (aimock's `X-Test-Id`, OpenClaw's `client_metadata.session_id`) | Asks every agent to change; it stays an optional strong signal (8.1, 2) |
| One server per test (emulate) | The agent is one process with one base URL |
| Timing ("the session whose delivery is in flight") | In parallel runs many are in flight. It can't decide, and it would make attribution flaky |
| Injecting a marker into people's text | Changes what the test wrote, and the agent may answer the marker |

### 8.6 Several calls in one test, in an order nobody controls

Inside one test, two mentions can be in flight at once: Ana and Ben both ask, or Ana asks twice quickly. Which model call reaches channelstack first is a race inside the agent, not something the test decides.

- **A static list answers in arrival order.** With `openai.respond(["A", "B"])`, whichever call arrives first gets "A". That's fine when the answers don't depend on which call is which.
- **When they do, use a responder.** The request carries its **context**: the message it answers, who sent it, and where (`request.context`, from the evidence of §8.1). The function answers each call for what it is:

  ```ts
  await openai.respond((request) =>
    request.context?.from?.id === ana.id ? "Your deploy is green." : "Your migration is still running.");
  ```

  `when: { from: ana }` and `when: { in: thread }` are the same check in static form.
- **Not enough turns is an error, never a reuse.** If more calls arrive than a static list has turns, the extra ones get the refusal of §8.4, and the test fails with "ms_2 has 2 turns; a 3rd call arrived". A list never repeats its last turn.
- **A call's context is as exact as its evidence.** With an id the agent sent (`user`), or the person's own text, it names the message. If one session sent the same text twice and nothing else tells them apart, `context.candidates` lists both, and a failing matcher mentions it.

## 9. Reading and asserting what the agent sent

```ts
const call = await openai.latestCall({ endpoint: "responses" });
await expect(call).toHaveSent([first, second, third], { ordered: true });   // the thread history, in order
await expect(openai).not.toHaveSent(secretInPrivateChannel);                 // no text from a channel it shouldn't read
await expect(openai).not.toHaveSentSecrets();                                // no tokens, signing secrets, keys
await expect(call).toHaveOfferedTool("search_incidents");
```

### 9.1 Tool calls and their results

`openai.toolCalls()`, `ai.toolCalls()` and `call.toolCalls` list the tool calls the model made. On a call it's a property, because a call is a finished record. On the fixture and a script it's a method, because it reads what has happened so far; a property there would be a snapshot taken when `respond()` returned, before any call. Each tool call is joined with the result the agent sent back in a later request, by its `call_…` id:

```ts
const ai = await openai.respond([
  { toolCalls: [{ name: "search_incidents", arguments: { since: "yesterday" } }, { name: "page_oncall", arguments: { team: "web" } }] },
  "Two incidents; I paged web's on-call.",
]);
await ana.say("@my-agent what broke yesterday?", { channel });
await expect(ai).toHaveAnswered({ times: 2 });

const calls = await ai.toolCalls();
expect(calls.map((c) => c.name)).toEqual(["search_incidents", "page_oncall"]);
expect(calls.every((c) => c.result)).toBe(true);          // the agent ran both and sent both results back
await expect(ai).toHaveSentToolResult("search_incidents", { text: /deploy/ });
```

A tool call without `result` is one the agent never answered, which is a bug class of its own: a parallel call dropped, or a loop that ended early.

### 9.2 Calls

- **`calls()` is the session's.** Every call attributed to it, with the normalised request and the response summary, in the event log like every other API call (`readCalls`, `recordCall`).
- **Redaction.** Recorded requests keep the agent's text, because asserting on it is the point. Headers drop `Authorization`. Secrets channelstack knows are redacted in logs and the UI as everywhere (`pnpm test:redaction`). The `toHaveSentSecrets` matcher runs in the server against the raw body before redaction, and returns only which kind of secret it found, never the value.

## 10. Wire fidelity

### 10.1 What the fake serves

- **Chat Completions:** `messages` with every role, text and image and file parts (counted, not read), `tools` with `strict`, `tool_choice`, `parallel_tool_calls`, `response_format` (`json_object`, `json_schema`), `stream` and `stream_options.include_usage`, `max_completion_tokens` (a turn longer than it ends with `finish_reason: "length"`), `n: 1`, `store` (no effect), `metadata`, `user`, `safety_identifier`.
- **Responses:** `input` as a string or items (messages, `function_call`, `function_call_output`, `reasoning`), `instructions`, `tools` (functions), `tool_choice`, `text.format`, `reasoning`, `include`, `store` (default true: stored responses serve `GET /v1/responses/{id}` and `previous_response_id`), `max_output_tokens` (`incomplete` with its reason), `background: false`, every streaming event with its `sequence_number`.
- **Images, audio, files:** the endpoints and parts of §5.5. `/v1/files` takes uploads (`purpose: "user_data"`, `"vision"`, …), serves `GET`, `content` and `DELETE`, and its ids work in `file_id` parts. A container's files are downloadable when a `codeInterpreter` call wrote them.
- **Built-in tools:** those of §5.6, on Responses.
- **Conversations:** `/v1/conversations` (create, retrieve, update, delete) and its items (list, add, retrieve, delete), and Responses' `conversation` parameter, which reads the conversation's items as input and adds the new input and output to it. It is on the same store as `previous_response_id`, and a request with both is refused as OpenAI refuses it. Conversation ids are `conv_` and 48 hex characters.
- **Models:** any model name is accepted, so gateways' names (`openai/gpt-…`, `llama-3.3-70b`) work. `GET /v1/models` lists current OpenAI model ids, plus every name the agent has used.

### 10.2 What it refuses, as OpenAI does

A missing `model` or `messages`, an unknown role, a `tool` message whose `tool_call_id` doesn't answer a call, `previous_response_id` that doesn't exist (`previous_response_not_found`), `n > 1` with tools, `json_schema` without `name`, an `X-Client-Request-Id` that isn't ASCII or is over 512 characters, and a missing or wrong key (401 `invalid_api_key`). Unknown tool types and unknown fields are recorded on the call rather than refused, unless OpenAI documents a refusal. emulate's refusal of Codex's `namespace` tools (#436) shows the cost of guessing. Each uses OpenAI's error body `{ error: { message, type, param, code } }`.

### 10.3 What isn't served

- **Refused with a 400** (`invalid_request_error`, code `unsupported_in_fake`, the counterpart of live mode's `unsupported_in_live`), naming what isn't supported: background responses and `n > 1` on Chat Completions.
- **Not served (OpenAI's 404):** embeddings, the vector store API, cancelling a response, Realtime, batches and fine-tuning.
- **Gone from OpenAI itself:** the Assistants API (sunset on 2026-08-26) and the Videos API (2026-09-24).


Compared with emulate: emulate refuses hosted tools and the Conversations API, which channelstack scripts and serves. It also serves video, which OpenAI has since shut down.

Each gap is a row in the reality matrix.

### 10.4 Ids and numbers

Ids look like OpenAI's: `chatcmpl-` and 29 base-62 characters, `resp_`/`msg_`/`fc_`/`rs_` and 48 hex characters, `call_` and 24, `req_` and 32, `fp_` and 10 for `system_fingerprint`, from the world's seeded random source, like every fake id. Usage is counted as about four characters a token, so numbers grow with the prompt and `context_length_exceeded` can be triggered by length. No tokenizer is bundled.

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

### 11.1 Gateway dialects, where they're cheap

The three that only rename or move what the fake already sends are included. The request picks the dialect, so nothing is configured:

| Dialect | Picked by | What changes |
|---|---|---|
| OpenRouter | a `reasoning` object in a Chat Completions request | the turn's reasoning summary is sent as `message.reasoning` and `delta.reasoning`, with `reasoning_details` |
| DeepSeek | the model name `deepseek-reasoner` (or one starting `deepseek-r`) | the reasoning summary is sent as `reasoning_content` in the message and its deltas |
| Azure OpenAI | the path: `/openai/deployments/{deployment}/chat/completions?api-version=…`, and `/openai/v1/…` | the deployment is the model name; the key comes in the `api-key` header; a missing `api-version` on deployment paths is refused as Azure refuses it |

Other gateway extensions (OpenRouter's provider routing, Groq's `x_groq`, LiteLLM's extra fields) are accepted and ignored.

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

`api.openai.com` is a routed host like `slack.com` and `api.github.com`: in proxy mode it always goes to the fake. So nothing reaches the real API, which gives OpenClaw's "fail if any call reaches the real provider host" for free. An agent behind the proxy that should use the real model with fake channels uses base-URL mode for the channels instead.

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

In pytest the fixture is named `openai`, which shadows the `openai` package inside a test that also imports it. That is accepted: a test seldom needs both.

### 12.5 The standard checks

Each channel's checks take the model: `slackChecks({ app: "my-agent", model: "openai" })` (and `model="openai"` in pytest). With it:

- **The checks script the model themselves.** The stream and Stop checks no longer need `streamPrompt`, because the check scripts a long, slow stream. Every check's prompt carries a unique token, so parallel checks are never attributed by order (§8.3).
- **New checks, one per model bug class:**

  | Check | What it does | The bug |
  |---|---|---|
  | `<channel>.slow-model` | `firstToken: "5s"`, with the platform's retry (Slack's 3s retry, a GitHub redelivery) | Duplicate replies |
  | `<channel>.model-error` | `overloaded` on every call | Status stuck on "Thinking…", nothing said to the person |
  | `<channel>.model-retry` | two `overloaded`, then an answer | Two replies when the SDK retries |
  | `slack.stream-breaks` | `failAfter: { chunks: 3 }` | A stream never stopped |
  | `slack.stop-cancels-model` | `pauseAfter`, then Stop, then the call must be `aborted` | Stop leaves the model running |
  | `<channel>.no-secrets-to-model` | `not.toHaveSentSecrets()` on every call of every check | Tokens in the prompt |

With the fake model in its environment, an **unmodified agent with no keys** runs them in CI:

```bash
npx channelstack start --no-portless --port 4500 &
npx channelstack env >> "$GITHUB_ENV"     # includes OPENAI_BASE_URL and OPENAI_API_KEY
pnpm start &                             # the agent, unchanged
pnpm vitest run                          # a file that calls slackChecks({ app: "my-agent", model: "openai" })
```

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
    const ai = await openai.respond([
      { toolCalls: [{ name: "search_incidents", arguments: { since: "yesterday" } }] },
      "Two incidents yesterday: the web deploy and a DNS blip.",
    ]);

    const msg = await ana.say("@my-agent what broke yesterday?", { channel });

    await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /DNS blip/ });
    await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
    await expect(ai).toHaveAnswered({ times: 2 });
    const [search] = await ai.toolCalls();
    expect(search?.result?.text).toBeDefined();               // the agent ran the tool and sent the result back
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
    const ai = await openai.respond({ text: "A long answer ".repeat(40), pauseAfter: 3 });

    const msg = await ana.say("write me a long report", { to: slack.app });
    const call = await ai.waitForPause();
    await ana.stop({ thread: msg });

    await expect(msg.thread).toHaveStatus("stopped");
    await expect(call).toBeAborted();
  });
});

describe("several calls at once", () => {
  // The reference agent sends the Slack user id as `user`, so each call's context names its person.
  test("two people ask at once; each gets the answer to their own question", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const ben = await slack.createUser({ name: "Ben" });
    const channel = await slack.createChannel({ participants: [ana, ben, slack.app] });
    await openai.respond((request) =>
      request.context?.from?.id === ana.id ? "Your deploy is green." : "Your migration is still running.",
    );

    const [a, b] = await Promise.all([
      ana.say("@my-agent how's my change doing?", { channel }),
      ben.say("@my-agent how's my change doing?", { channel }),
    ]);

    await expect(a.thread).toHaveReplyFrom("my-agent", { text: /deploy is green/ });
    await expect(b.thread).toHaveReplyFrom("my-agent", { text: /migration/ });
  });
});

describe("images and built-in tools", () => {
  test("the screenshot Ana shares reaches the model", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    await openai.respond("The stack trace points at the migration.");

    await ana.say("@my-agent what's wrong here?", { channel, files: "./fixtures/error.png" });

    const call = await openai.waitForCall();
    await expect(call).toHaveSentFile("./fixtures/error.png");   // downloaded with the bot token, sent as bytes
  });

  test("a generated chart is posted in the thread", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    await openai.respond({
      toolCalls: [{ imageGeneration: { image: "./fixtures/chart.png" } }],
      text: "Here's this week's deploys.",
    });

    const msg = await ana.say("@my-agent chart this week's deploys", { channel });

    const reply = await msg.thread.waitForReply({ from: "my-agent" });
    expect(reply.files).toHaveLength(1);
  });

  test("an MCP approval becomes a button, and only the click runs the tool", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana", admin: true });
    const deploy = { server: "deploys", tool: "deploy", arguments: { app: "web" } };
    const ai = await openai.respond([
      { toolCalls: [{ mcp: { ...deploy, approval: true } }] },
      { toolCalls: [{ mcp: { ...deploy, output: "started" } }], text: "Deploying web." },
    ]);

    const msg = await ana.say("deploy web", { to: slack.app });
    const ask = await msg.thread.waitForReply({ from: "my-agent" });
    await expect(ai).toHaveAnswered({ times: 1 });              // nothing runs before the click
    await ana.click("Approve", { message: ask });

    await expect(msg.thread).toHaveReplyFrom("my-agent", { text: /Deploying web/ });
    await expect(ai).toHaveAnswered({ times: 2 });
  });
});

describe("a missing script fails the test", () => {
  // The agent calls the model, but the test scripted nothing for "status?". The agent gets a 400
  // (channelstack_no_script) and the matcher fails at once with the missing respond(…) in its message.
  test.fails("an unscripted model call is an error, not a made-up answer", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    await openai.respond("Deploying.", { when: { text: "deploy" } });

    const msg = await ana.say("status?", { to: slack.app });

    await expect(msg.thread).toHaveReplyFrom("my-agent");
  });

  test("plan limits: the agent tells the person, once, and stops retrying", async ({ slack, openai }) => {
    const ana = await slack.createUser({ name: "Ana" });
    await openai.respond({ error: "project_spend_limit_exceeded" }, { times: Infinity });

    const msg = await ana.say("summarize #support", { to: slack.app });

    await expect(msg.thread).toHaveRepliesFrom("my-agent", { count: 1 });
    await expect(msg.thread).toHaveStatus("idle");
    await expect(openai).toHaveReceivedCall("chat.completions", { times: 1 });   // insufficient_quota isn't worth a retry
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
| Images, audio, files | `server/src/providers/openai/media.ts`: parts and their hashes, multipart bodies, placeholders (PNG, WAV), `/v1/files`, fetching a URL on a fake host without credentials | Hono's body parsing; `node:zlib` for PNG |
| Built-in tools | `server/src/providers/openai/tools/`, one file per tool: its items, annotations and events | the SSE writer |
| Scripts, responders, templates, the rate limit | `server/src/providers/openai/scripts.ts`, `rate-limit.ts` | session lifetime, like faults; the injected clock |
| Routes | `providers/openai/routes.ts`: `respond`, `calls`, `unattributed`, the responder's `requests` and `answer` | `registerRoute`, `readCalls`, `recordCall` |
| SDK runtime | `responder` in each SDK runtime | `wait`, transport |
| Matchers | `integrations/matchers-core/` (and pytest's and Rust's counterparts) | the read methods |
| Checks | `integrations/checks/`: the model checks of §12.5 | public API only |

It needs a few decisions in code. `check:channels` must not treat a provider as a channel. The quiet detector must count a held or stalled model call. The redaction check must learn the OpenAI key's `sk-proj-` prefix.

Dependencies: none new in the server for the protocol. JSON Schema validation of tool arguments and structured output needs a validator (Ajv, MIT, pure JS) unless Zod 4's JSON Schema support is enough. The official `openai` package becomes a dev dependency for conformance tests and the reference agent.

## 15. Open questions

None. The last five were answered in the third round (§16).

## 16. Settled in review

| | Decision |
|---|---|
| Fixture name | `openai`, in every language (pytest's shadows the `openai` package inside a test that imports it; accepted) |
| A script's variable | `ai`: `const ai = await openai.respond(…)` |
| Tool calls | `openai.toolCalls()` and `ai.toolCalls()` are methods, `call.toolCalls` a property (§9.1). Each is joined with the agent's result; `toHaveSentToolResult` sits beside `toHaveOfferedTool` |
| Unscripted calls | No default answer. The agent gets a 400 `channelstack_no_script`, and the test fails at once in its matchers, or at the latest when its session closes (§8.4) |
| Same text from parallel tests | The test's job: give each prompt something of its own. The call goes to the oldest message's session, and a failure says it was attributed by order (§8.3) |
| Calls in an unknown order | A static list answers in arrival order and fails when it runs out. Answers that depend on which call is which use a responder and `request.context`, or `when: { from, in }` (§8.6) |
| Unknown model names | Accepted |
| Token counts | About four characters a token |
| Rate limits | A per-session limiter with truthful headers (§7.4), and OpenAI's documented plan, spend and access errors as error turns (§4.2) |
| Multi-modal | Images, audio and files in and out (§5.5); no video, since OpenAI shut that API down |
| Built-in tools | All of them, scripted, never run (§5.6) |
| Embeddings | Not served |
| Conversations API | Served (§10.1): it's current, and it replaced the Assistants API |
| MCP servers | Scripted only; the fake never calls a `server_url` |
| Refusal codes | `channelstack_no_script` and `unsupported_in_fake` |
| Phases | The next two: phase 13 (the core) and phase 14 (images, audio, files, built-in tools), as stacked pull requests |
| Gateway dialects | OpenRouter's `reasoning`, DeepSeek's `reasoning_content` and Azure's deployment paths, because they're cheap (§11.1) |
| Proxy mode | `api.openai.com` is always routed to the fake (§12.3) |
| `channelstack check` | Not added. The checks run in the developer's own Vitest or pytest suite |
| Other providers | None: no Anthropic |
| Decision record | [0029](../../docs/decisions/0029-fake-openai.md) (0028 is taken by PR #107). It reverses the `AGENTS.md` **Models** row and `devx.md` §6 |
