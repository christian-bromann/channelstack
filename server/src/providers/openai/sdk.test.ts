/**
 * The fake OpenAI against the official `openai` SDK, in process (exit checks 13.3, 13.4, 13.7,
 * 13.8, 13.10 and 13.11): every turn kind on both endpoints, streamed and not, every error turn
 * and the SDK's retries, timing and breaks on the injected clock, rate limits, the secrets an
 * agent sends, scripts that run out, and the store behind `previous_response_id` and conversations.
 */
import type OpenAI from "openai";
import {
  APIError,
  APIUserAbortError,
  AuthenticationError,
  AzureOpenAI,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "openai";
import { describe, expect, test, vi } from "vitest";

import { TOKEN } from "../../../test/app-harness.ts";
import { useOpenAIWorkspace } from "../../../test/openai-workspace.ts";
import { PREFIXED_TOKENS } from "../../../test/prefixed-tokens.ts";
import { DRIVERS, secretSpecs } from "../../drivers/index.ts";

const setup = useOpenAIWorkspace();

/** Let the in-process server and the SDK run what is ready: promises, and the stream reads they wait on. */
const settle = async (rounds = 20) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** Wait (in real time, briefly) until `ready` holds: what the server does next is the test's to set off. */
async function until(ready: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let round = 0; round < 500; round += 1) {
    if (await ready()) return;
    await settle(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const ask = (prompt: string) => [{ role: "user" as const, content: prompt }];

describe("no script, no answer", () => {
  test("an unscripted call is a 400 naming the missing respond(…), and a problem of the session", async () => {
    const { client, control, prompt } = await setup();

    const error = await client.chat.completions
      .create({ model: "gpt-5", messages: ask(prompt) })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).status).toBe(400);
    expect((error as APIError).code).toBe("channelstack_no_script");
    expect((error as APIError).message).toMatch(/what broke in the web deploy yesterday\?/);
    expect(await control("GET", "/problems")).toEqual([expect.stringMatching(/no openai\.respond/)]);
  });

  test("a list that runs out refuses the next call, and says so", async () => {
    const { client, respond, control, prompt } = await setup();
    await respond({ turns: ["Only once."] });

    const first = await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt) });
    const second = await client.chat.completions
      .create({ model: "gpt-5", messages: ask(prompt) })
      .catch((caught: unknown) => caught);

    expect(first.choices[0]?.message.content).toBe("Only once.");
    expect((second as APIError).code).toBe("channelstack_no_script");
    expect(await control("GET", "/problems")).toContainEqual(expect.stringMatching(/has 1 turn; call 2 arrived/));
  });

  test("a call no session claims is refused and listed as unattributed", async () => {
    const { client, control } = await setup();

    const error = await client.chat.completions
      .create({ model: "gpt-5", messages: ask("summarise the backlog every morning") })
      .catch((caught: unknown) => caught);

    expect((error as APIError).code).toBe("channelstack_no_script");
    expect(await control("GET", "/unattributed")).toEqual([
      expect.objectContaining({ lastUserText: "summarise the backlog every morning", endpoint: "chat.completions" }),
    ]);
  });
});

describe("Chat Completions", () => {
  test("text, with OpenAI's headers and usage", async () => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: ["Two incidents: the web deploy and a DNS blip."] });

    const { data, response } = await client.chat.completions
      .create({ model: "gpt-5", messages: ask(prompt) })
      .withResponse();

    expect(data.choices[0]?.message.content).toBe("Two incidents: the web deploy and a DNS blip.");
    expect(data.choices[0]?.finish_reason).toBe("stop");
    expect(data.id).toMatch(/^chatcmpl-[0-9A-Za-z]{29}$/);
    expect(data.usage?.prompt_tokens).toBeGreaterThan(0);
    expect(response.headers.get("x-request-id")).toMatch(/^req_[0-9a-f]{32}$/);
    expect(response.headers.get("x-ratelimit-remaining-requests")).toMatch(/^\d+$/);
    expect(response.headers.get("openai-version")).toBe("2020-10-01");
  });

  test("a tool loop: the follow-up is the same session's by the tool call's id", async () => {
    const { client, respond, control, prompt } = await setup();
    await respond({
      turns: [
        { toolCalls: [{ name: "search_incidents", arguments: { since: "yesterday" } }] },
        "Found: {toolResult.search_incidents}",
      ],
    });
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "search_incidents",
          parameters: { type: "object", properties: { since: { type: "string" } } },
        },
      },
    ];

    const first = await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt), tools });
    const call = first.choices[0]?.message.tool_calls?.[0];
    expect(first.choices[0]?.finish_reason).toBe("tool_calls");
    expect(call?.type === "function" && JSON.parse(call.function.arguments)).toEqual({ since: "yesterday" });

    // The follow-up doesn't repeat Ana's words: only the tool call's id ties it to her session.
    const second = await client.chat.completions.create({
      model: "gpt-5",
      tools,
      messages: [
        { role: "assistant", content: null, tool_calls: first.choices[0]?.message.tool_calls ?? [] },
        { role: "tool", tool_call_id: call?.id ?? "", content: "the web deploy failed at the migration" },
      ],
    });
    expect(second.choices[0]?.message.content).toBe("Found: the web deploy failed at the migration");

    const toolCalls = await control("GET", "/tool-calls");
    expect(toolCalls).toEqual([
      expect.objectContaining({
        name: "search_incidents",
        arguments: { since: "yesterday" },
        result: expect.objectContaining({ text: "the web deploy failed at the migration" }),
      }),
    ]);
    const calls = await control("GET", "/calls");
    expect(
      calls.map(
        (recorded: { request: { context: { attributedBy?: string } } }) => recorded.request.context.attributedBy,
      ),
    ).toEqual([expect.stringMatching(/^(text|owned_id)$/), "minted_id"]);
  });

  test("a stream: content in pieces, tool calls with their arguments, the usage chunk and [DONE]", async () => {
    const { client, respond, prompt } = await setup();
    await respond({
      turns: [
        { text: ["Looking", " it up."], toolCalls: [{ name: "lookup", arguments: { query: "web deploy failed" } }] },
      ],
    });

    const stream = await client.chat.completions.create({
      model: "gpt-5",
      messages: ask(prompt),
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = "";
    let args = "";
    let usage: unknown;
    let finish: string | null | undefined;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      text += choice?.delta.content ?? "";
      args += choice?.delta.tool_calls?.[0]?.function?.arguments ?? "";
      finish = choice?.finish_reason ?? finish;
      if (chunk.usage) usage = chunk.usage;
    }

    expect(text).toBe("Looking it up.");
    expect(JSON.parse(args)).toEqual({ query: "web deploy failed" });
    expect(finish).toBe("tool_calls");
    expect(usage).toEqual(expect.objectContaining({ total_tokens: expect.any(Number) }));
  });

  test("a stream that breaks with an error event makes the SDK throw midway", async () => {
    const { client, respond, control, prompt } = await setup();
    await respond({ turns: [{ text: ["one", " two", " three", " four"], failAfter: { chunks: 2 } }] });

    const stream = await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt), stream: true });
    let text = "";
    const error = await (async () => {
      for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? "";
    })().catch((caught: unknown) => caught);

    expect(text).toBe("one two");
    expect(error).toBeInstanceOf(APIError);
    const [call] = await control("GET", "/calls");
    expect(call.response).toEqual(expect.objectContaining({ end: "errored", chunksSent: 2 }));
  });
});

describe("errors and the SDK's retries", () => {
  test("overloaded twice: the SDK retries, and the third call gets the answer", async () => {
    const { client, respond, control, prompt } = await setup();
    await respond({ turns: [{ error: "overloaded" }, { error: "overloaded" }, "All good now."] });

    const answer = await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt) });

    expect(answer.choices[0]?.message.content).toBe("All good now.");
    const calls = await control("GET", "/calls");
    expect(
      calls.map((call: { response: { status: number }; attempt: number }) => [call.response.status, call.attempt]),
    ).toEqual([
      [503, 0],
      [503, 1],
      [200, 2],
    ]);
  });
});

describe("Responses", () => {
  test("text and reasoning, streamed as OpenAI's events with sequence numbers", async () => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: [{ reasoning: { summary: "Reading the incident log." }, text: "Two incidents." }] });

    const stream = await client.responses.create({
      model: "gpt-5",
      input: prompt,
      stream: true,
      reasoning: { summary: "auto" },
    });
    const types: string[] = [];
    const sequence: number[] = [];
    let text = "";
    for await (const event of stream) {
      types.push(event.type);
      sequence.push(event.sequence_number);
      if (event.type === "response.output_text.delta") text += event.delta;
    }

    expect(text).toBe("Two incidents.");
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.reasoning_summary_text.delta");
    expect(types.at(-1)).toBe("response.completed");
    expect(sequence).toEqual(sequence.map((_, at) => at));
  });

  test("a function call, then previous_response_id chains the answer to the same session", async () => {
    const { client, respond, prompt } = await setup();
    await respond({
      turns: [{ toolCalls: [{ name: "lookup", arguments: { query: "deploy" } }] }, "It was the migration."],
    });
    const tools = [{ type: "function" as const, name: "lookup", parameters: { type: "object" }, strict: false }];

    const first = await client.responses.create({ model: "gpt-5", input: prompt, tools });
    const call = first.output.find((item) => item.type === "function_call");
    const second = await client.responses.create({
      model: "gpt-5",
      tools,
      previous_response_id: first.id,
      input: [
        {
          type: "function_call_output",
          call_id: call?.type === "function_call" ? call.call_id : "",
          output: "failed at the migration",
        },
      ],
    });

    expect(first.id).toMatch(/^resp_[0-9a-f]{48}$/);
    expect(call).toEqual(expect.objectContaining({ name: "lookup", arguments: '{"query":"deploy"}' }));
    expect(second.output_text).toBe("It was the migration.");
    expect((await client.responses.retrieve(second.id)).previous_response_id).toBe(first.id);
  });

  test("an unknown previous_response_id is refused as OpenAI refuses it", async () => {
    const { client, prompt } = await setup();

    const error = (await client.responses
      .create({ model: "gpt-5", input: prompt, previous_response_id: `resp_${"0".repeat(48)}` })
      .catch((caught: unknown) => caught)) as APIError;

    expect(error.status).toBe(400);
    expect(error.code).toBe("previous_response_not_found");
  });

  test("a conversation's items grow with each response", async () => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: ["First answer.", "Second answer."] });

    const conversation = await client.conversations.create({});
    await client.responses.create({ model: "gpt-5", input: prompt, conversation: conversation.id });
    await client.responses.create({ model: "gpt-5", input: "and the API?", conversation: conversation.id });
    const items = await client.conversations.items.list(conversation.id, { order: "asc" });

    expect(conversation.id).toMatch(/^conv_[0-9a-f]{48}$/);
    expect(items.data.map((item) => item.type)).toEqual(["message", "message", "message", "message"]);
  });
});

describe("what the agent sent", () => {
  test("a secret in the prompt is reported by its kind, and scrubbed from what calls() returns", async () => {
    const { client, respond, control, h, prompt } = await setup();
    await respond({ turns: ["ok"] });
    const token = h.secrets.get("slack", "botToken");

    await client.chat.completions.create({
      model: "gpt-5",
      messages: [...ask(prompt), { role: "user", content: `my token is ${token}` }],
    });

    expect(await control("GET", "/sent-secrets")).toEqual([expect.objectContaining({ kinds: ["slack.botToken"] })]);
    const [call] = await control("GET", "/calls");
    expect(JSON.stringify(call)).not.toContain(token);
  });

  test("a call's context: the channel, the person and the message it answers", async () => {
    const { client, respond, control, ana, channel, prompt } = await setup();
    await respond({ turns: ["ok"] });

    await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt), user: ana.id });

    const [call] = await control("GET", "/calls");
    expect(call.request.context).toEqual(
      expect.objectContaining({
        channel: "slack",
        from: { id: ana.id },
        conversation: { id: channel.id },
        attributedBy: "tag",
      }),
    );
  });
});

describe("gateway dialects", () => {
  test("OpenRouter's reasoning field, when the request asks for it", async () => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: [{ reasoning: { summary: "Checking the log." }, text: "Two incidents." }] });

    const answer = await client.chat.completions.create({
      model: "openai/gpt-5",
      messages: ask(prompt),
      // OpenRouter's own request field, beside OpenAI's.
      ...({ reasoning: { effort: "low" } } as object),
    });

    expect(answer.choices[0]?.message).toEqual(
      expect.objectContaining({ content: "Two incidents.", reasoning: "Checking the log." }),
    );
  });

  test("DeepSeek's reasoning_content, for its reasoning models", async () => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: [{ reasoning: { summary: "Checking the log." }, text: "Two incidents." }] });

    const answer = await client.chat.completions.create({ model: "deepseek-reasoner", messages: ask(prompt) });

    expect(answer.choices[0]?.message).toEqual(expect.objectContaining({ reasoning_content: "Checking the log." }));
  });

  test("Azure OpenAI on a deployment path, with its api-key header", async () => {
    const { h, respond, control, prompt } = await setup();
    await respond({ turns: ["From Azure."] });
    const azure = new AzureOpenAI({
      apiKey: h.secrets.get("openai", "apiKey"),
      endpoint: "http://127.0.0.1:4500/openai",
      deployment: "my-gpt-5",
      apiVersion: "2025-04-01-preview",
      fetch: (input, init) => Promise.resolve(h.app.fetch(new Request(input as string, init as RequestInit))),
    });

    const answer = await azure.chat.completions.create({ model: "", messages: ask(prompt) });

    expect(answer.choices[0]?.message.content).toBe("From Azure.");
    const [call] = await control("GET", "/calls");
    expect(call.model).toBe("my-gpt-5");
  });
});

describe("reasoning sent back", () => {
  test("the fake's own encrypted reasoning comes back valid; any other blob is refused", async () => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: [{ reasoning: { summary: "Thinking." }, text: "First." }, "Second."] });

    const first = await client.responses.create({
      model: "gpt-5",
      input: prompt,
      store: false,
      include: ["reasoning.encrypted_content"],
    });
    const reasoning = first.output.find((item) => item.type === "reasoning");
    expect(reasoning?.type === "reasoning" && reasoning.encrypted_content).toMatch(/^gAAAAA/);

    const second = await client.responses.create({
      model: "gpt-5",
      store: false,
      input: [...first.output, { role: "user", content: "and the API?" }] as never,
    });
    expect(second.output_text).toBe("Second.");

    const forged = (await client.responses
      .create({
        model: "gpt-5",
        store: false,
        input: [
          { type: "reasoning", id: "rs_x", summary: [], encrypted_content: "gAAAAAforged" },
          { role: "user", content: prompt },
        ] as never,
      })
      .catch((caught: unknown) => caught)) as APIError;
    expect(forged.status).toBe(400);
    expect(forged.code).toBe("invalid_encrypted_content");
  });
});

type Endpoint = "chat.completions" | "responses";
const ENDPOINTS: readonly Endpoint[] = ["chat.completions", "responses"];
type Client = OpenAI;

/** One call of the agent's kind, on either endpoint, streamed or not: what the SDK returns, or throws. */
function callOn(
  client: Client,
  endpoint: Endpoint,
  stream: boolean,
  prompt: string,
  options: { signal?: AbortSignal } = {},
) {
  return endpoint === "chat.completions"
    ? client.chat.completions.create({ model: "gpt-5", messages: ask(prompt), stream }, options)
    : client.responses.create({ model: "gpt-5", input: prompt, stream }, options);
}

/** The text deltas of a stream of either endpoint, as the SDK yields them. */
function deltaOf(endpoint: Endpoint, event: unknown): string {
  if (endpoint === "chat.completions") {
    return (event as OpenAI.Chat.ChatCompletionChunk).choices[0]?.delta.content ?? "";
  }
  const typed = event as OpenAI.Responses.ResponseStreamEvent;
  return typed.type === "response.output_text.delta" ? typed.delta : "";
}

/** What an answer says, the same way for both endpoints. */
interface Seen {
  text: string;
  deltas: string[];
  refusal: string | null;
  toolCalls: Array<{ kind: "function" | "custom"; name: string; input: string }>;
  finish: string;
  reasoning: string;
  usage: { input: number; output: number; reasoning: number; cached: number };
}

const CHAT_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  { type: "function", function: { name: "lookup", parameters: { type: "object" } } },
  { type: "custom", custom: { name: "run_sql" } },
];
const RESPONSES_TOOLS: OpenAI.Responses.Tool[] = [
  { type: "function", name: "lookup", parameters: { type: "object" }, strict: false },
  { type: "custom", name: "run_sql" },
];

function seenOfCompletion(completion: OpenAI.Chat.ChatCompletion, deltas: string[]): Seen {
  const choice = completion.choices[0];
  const message = choice?.message;
  const usage = completion.usage;
  return {
    text: message?.content ?? "",
    deltas,
    refusal: message?.refusal ?? null,
    toolCalls: (message?.tool_calls ?? []).map((call) =>
      call.type === "function"
        ? { kind: "function" as const, name: call.function.name, input: call.function.arguments }
        : { kind: "custom" as const, name: call.custom.name, input: call.custom.input },
    ),
    finish: choice?.finish_reason ?? "",
    reasoning: "",
    usage: {
      input: usage?.prompt_tokens ?? -1,
      output: usage?.completion_tokens ?? -1,
      reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? -1,
      cached: usage?.prompt_tokens_details?.cached_tokens ?? -1,
    },
  };
}

function seenOfResponse(response: OpenAI.Responses.Response, deltas: string[]): Seen {
  const seen: Seen = {
    text: "",
    deltas,
    refusal: null,
    toolCalls: [],
    finish:
      response.status === "incomplete" ? `incomplete: ${response.incomplete_details?.reason}` : String(response.status),
    reasoning: "",
    usage: {
      input: response.usage?.input_tokens ?? -1,
      output: response.usage?.output_tokens ?? -1,
      reasoning: response.usage?.output_tokens_details.reasoning_tokens ?? -1,
      cached: response.usage?.input_tokens_details.cached_tokens ?? -1,
    },
  };
  for (const item of response.output) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") seen.text += part.text;
        else seen.refusal = part.refusal;
      }
    } else if (item.type === "function_call") {
      seen.toolCalls.push({ kind: "function", name: item.name, input: item.arguments });
    } else if (item.type === "custom_tool_call") {
      seen.toolCalls.push({ kind: "custom", name: item.name, input: item.input });
    } else if (item.type === "reasoning") {
      seen.reasoning += item.summary.map((part) => part.text).join("");
    }
  }
  return seen;
}

/** Ask on an endpoint the way an agent does, through the SDK's own helpers when streamed, and read the answer. */
async function answerOn(client: Client, endpoint: Endpoint, stream: boolean, prompt: string): Promise<Seen> {
  const deltas: string[] = [];
  if (endpoint === "chat.completions") {
    const params = { model: "gpt-5", messages: ask(prompt), tools: CHAT_TOOLS };
    if (!stream) return seenOfCompletion(await client.chat.completions.create(params), deltas);
    const streamed = client.chat.completions.stream({ ...params, stream_options: { include_usage: true } });
    for await (const chunk of streamed) {
      const delta = deltaOf(endpoint, chunk);
      if (delta !== "") deltas.push(delta);
    }
    return seenOfCompletion(await streamed.finalChatCompletion(), deltas);
  }
  const params = {
    model: "gpt-5",
    input: prompt,
    tools: RESPONSES_TOOLS,
    reasoning: { summary: "auto" as const },
  };
  if (!stream) return seenOfResponse(await client.responses.create(params), deltas);
  const streamed = client.responses.stream(params);
  for await (const event of streamed) {
    const delta = deltaOf(endpoint, event);
    if (delta !== "") deltas.push(delta);
  }
  return seenOfResponse(await streamed.finalResponse(), deltas);
}

/** Every turn kind, and what each endpoint makes of it (exit check 13.3). */
const TURN_KINDS: ReadonlyArray<{
  kind: string;
  turn: unknown;
  seen: Partial<Seen>;
  on: Record<Endpoint, Partial<Seen>>;
}> = [
  {
    kind: "text",
    turn: "Two incidents.",
    seen: { text: "Two incidents.", refusal: null, toolCalls: [] },
    on: { "chat.completions": { finish: "stop" }, responses: { finish: "completed" } },
  },
  {
    kind: "chunks",
    turn: { text: ["Two", " incidents", "."] },
    seen: { text: "Two incidents." },
    on: { "chat.completions": { finish: "stop" }, responses: { finish: "completed" } },
  },
  {
    kind: "a function call",
    turn: { toolCalls: [{ name: "lookup", arguments: { query: "web deploy" } }] },
    seen: { toolCalls: [{ kind: "function", name: "lookup", input: '{"query":"web deploy"}' }] },
    on: { "chat.completions": { finish: "tool_calls", text: "" }, responses: { finish: "completed" } },
  },
  {
    kind: "a custom tool call",
    turn: { toolCalls: [{ name: "run_sql", input: "SELECT count(*) FROM incidents" }] },
    seen: { toolCalls: [{ kind: "custom", name: "run_sql", input: "SELECT count(*) FROM incidents" }] },
    on: { "chat.completions": { finish: "tool_calls" }, responses: { finish: "completed" } },
  },
  {
    kind: "reasoning",
    turn: { reasoning: { summary: "Reading the incident log.", tokens: 12 }, text: "Two incidents." },
    seen: { text: "Two incidents.", usage: expect.objectContaining({ reasoning: 12 }) },
    // OpenAI sends no reasoning summary on Chat Completions: only its token count.
    on: { "chat.completions": { reasoning: "" }, responses: { reasoning: "Reading the incident log." } },
  },
  {
    kind: "a refusal",
    turn: { refusal: "I can't help with that." },
    seen: { text: "", refusal: "I can't help with that." },
    on: { "chat.completions": { finish: "stop" }, responses: { finish: "completed" } },
  },
  {
    kind: "finish: length",
    turn: { text: "Two inc", finish: "length" },
    seen: { text: "Two inc" },
    on: { "chat.completions": { finish: "length" }, responses: { finish: "incomplete: max_output_tokens" } },
  },
  {
    kind: "finish: content_filter",
    turn: { text: "", finish: "content_filter" },
    seen: { text: "" },
    on: { "chat.completions": { finish: "content_filter" }, responses: { finish: "incomplete: content_filter" } },
  },
  {
    kind: "usage",
    turn: { text: "ok", usage: { input: 100, output: 20, reasoning: 5, cached: 40 } },
    seen: { text: "ok", usage: { input: 100, output: 20, reasoning: 5, cached: 40 } },
    on: { "chat.completions": {}, responses: {} },
  },
];

describe.each(ENDPOINTS)("every turn kind, as the official SDK parses it: %s", (endpoint) => {
  describe.each([false, true])("streamed: %s", (stream) => {
    test.each(TURN_KINDS)("$kind", async ({ turn, seen, on }) => {
      const { client, respond, prompt } = await setup();
      await respond({ turns: [turn] });

      const answer = await answerOn(client, endpoint, stream, prompt);

      expect(answer).toMatchObject({ ...seen, ...on[endpoint] });
      expect(answer.usage.input).toBeGreaterThan(0);
      if (stream) expect(answer.deltas.join("")).toBe(answer.text);
      if (stream && Array.isArray((turn as { text?: unknown }).text)) {
        expect(answer.deltas).toEqual((turn as { text: string[] }).text);
      }
    });
  });

  test.each([false, true])("structured output, streamed: %s", async (stream) => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: ['{"incidents":2}'] });
    const schema = {
      type: "object",
      properties: { incidents: { type: "integer" } },
      required: ["incidents"],
      additionalProperties: false,
    };

    let parsed: unknown;
    if (endpoint === "chat.completions") {
      const params = {
        model: "gpt-5",
        messages: ask(prompt),
        response_format: { type: "json_schema" as const, json_schema: { name: "incidents", strict: true, schema } },
      };
      parsed = stream
        ? (await client.chat.completions.stream(params).finalChatCompletion()).choices[0]?.message.parsed
        : (await client.chat.completions.parse(params)).choices[0]?.message.parsed;
    } else {
      const params = {
        model: "gpt-5",
        input: prompt,
        text: { format: { type: "json_schema" as const, name: "incidents", strict: true, schema } },
      };
      parsed = stream
        ? (await client.responses.stream(params).finalResponse()).output_parsed
        : (await client.responses.parse(params)).output_parsed;
    }

    expect(parsed).toEqual({ incidents: 2 });
  });
});

describe("a stored response", () => {
  test("is retrieved, lists its input items, is deleted, and is then not found", async () => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: ["Two incidents."] });

    const created = await client.responses.create({ model: "gpt-5", input: prompt });
    const retrieved = await client.responses.retrieve(created.id);
    const items = await client.responses.inputItems.list(created.id);
    await client.responses.delete(created.id);
    const gone = await client.responses.retrieve(created.id).catch((caught: unknown) => caught);

    expect(retrieved).toMatchObject({ id: created.id, output_text: "Two incidents." });
    expect(items.data).toEqual([expect.objectContaining({ type: "message", role: "user" })]);
    expect(gone).toBeInstanceOf(NotFoundError);
    expect(gone).toMatchObject({ status: 404 });
  });
});

/**
 * Every error turn: the SDK's class for it, OpenAI's status, `type` and `code`, and whether the
 * SDK retries it (429 and 5xx, twice by default; never a 400, 401 or 403).
 */
const ERROR_TURNS = [
  ["rate_limit", RateLimitError, 429, "requests", "rate_limit_exceeded", true],
  ["slow_down", RateLimitError, 429, "rate_limit_error", "slow_down", true],
  ["insufficient_quota", RateLimitError, 429, "insufficient_quota", "insufficient_quota", true],
  ["credit_balance_exhausted", RateLimitError, 429, "insufficient_quota", "credit_balance_exhausted", true],
  [
    "organization_spend_limit_exceeded",
    RateLimitError,
    429,
    "insufficient_quota",
    "organization_spend_limit_exceeded",
    true,
  ],
  ["project_spend_limit_exceeded", RateLimitError, 429, "insufficient_quota", "project_spend_limit_exceeded", true],
  [
    "organization_usage_limit_exceeded",
    RateLimitError,
    429,
    "insufficient_quota",
    "organization_usage_limit_exceeded",
    true,
  ],
  ["server_error", InternalServerError, 500, "server_error", null, true],
  ["overloaded", InternalServerError, 503, "service_unavailable_error", "server_is_overloaded", true],
  ["context_length_exceeded", BadRequestError, 400, "invalid_request_error", "context_length_exceeded", false],
  ["content_policy", BadRequestError, 400, "invalid_request_error", "invalid_prompt", false],
  ["invalid_api_key", AuthenticationError, 401, "invalid_request_error", "invalid_api_key", false],
  ["not_in_organization", AuthenticationError, 401, "invalid_request_error", "no_organization", false],
  ["ip_not_authorized", AuthenticationError, 401, "invalid_request_error", "ip_not_authorized", false],
  [
    "unsupported_region",
    PermissionDeniedError,
    403,
    "request_forbidden",
    "unsupported_country_region_territory",
    false,
  ],
] as const;

describe.each(ENDPOINTS)("every error turn, as the official SDK raises it: %s", (endpoint) => {
  describe.each([false, true])("streamed: %s", (stream) => {
    test.each(ERROR_TURNS)("%s", async (kind, ErrorClass, status, type, code, retried) => {
      const { client, respond, control, prompt } = await setup();
      await respond({ turns: [{ error: kind }], times: -1 });

      const error = await callOn(client, endpoint, stream, prompt).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ErrorClass);
      expect(error).toMatchObject({ status, type, code });
      // The SDK's default two retries, or none: exactly what its rules say for this status.
      expect(await control("GET", "/calls")).toHaveLength(retried ? 3 : 1);
    });
  });
});

describe("the SDK's retries", () => {
  test("x-should-retry: false stops the retry of a 503, with the SDK's default retries", async () => {
    const { client, respond, control, prompt } = await setup();
    await respond({ turns: [{ error: "overloaded", shouldRetry: false }], times: -1 });

    const error = await callOn(client, "chat.completions", false, prompt).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InternalServerError);
    expect(await control("GET", "/calls")).toHaveLength(1);
  });

  test("x-should-retry: true makes the SDK retry a 400 it otherwise wouldn't", async () => {
    const { client, respond, control, prompt } = await setup();
    await respond({ turns: [{ error: "content_policy", shouldRetry: true }], times: -1 });

    const error = await callOn(client, "responses", false, prompt).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestError);
    expect(await control("GET", "/calls")).toHaveLength(3);
  });

  test("the SDK waits what retry-after-ms says, not retry-after's whole seconds, before it retries", async () => {
    const { client, respond, control, prompt } = await setup();
    await respond({ turns: [{ error: "overloaded", retryAfter: 1200 }, "All good now."] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timers = vi.spyOn(globalThis, "setTimeout");

    const answer = client.chat.completions.create({ model: "gpt-5", messages: ask(prompt) });
    await until(() => timers.mock.calls.some(([, ms]) => ms === 1200), "the SDK to wait before its retry");
    await vi.advanceTimersByTimeAsync(1199);
    const waiting = await control("GET", "/calls");
    await vi.advanceTimersByTimeAsync(1);

    expect((await answer).choices[0]?.message.content).toBe("All good now.");
    expect(waiting).toHaveLength(1);
    expect(await control("GET", "/calls")).toHaveLength(2);
    // retry-after rounds up to 2 seconds: the SDK never waited that long.
    expect(timers.mock.calls.some(([, ms]) => ms === 2000)).toBe(false);
  });
});

describe("timing and breaks on the injected clock, as the SDK sees them", () => {
  test("firstToken holds the answer until that much time has passed", async () => {
    const { client, respond, h, prompt } = await setup();
    await respond({ turns: [{ text: "Two incidents.", timing: { firstToken: 2000 } }] });
    // The server's clock moves only when the test moves it: the call's age is the timers' time alone.
    vi.useFakeTimers({ toFake: ["Date"] });
    const before = h.timers.waiting();

    let answered = false;
    const answer = client.chat.completions
      .create({ model: "gpt-5", messages: ask(prompt) })
      .finally(() => (answered = true));
    await until(() => h.timers.waiting() > before, "the answer to wait for its first token");
    h.timers.advance(1999);
    await settle();
    const early = answered;
    h.timers.advance(1);

    expect((await answer).choices[0]?.message.content).toBe("Two incidents.");
    expect(early).toBe(false);
  });

  test("firstToken holds a stream's headers too, and betweenChunks paces its chunks", async () => {
    const { client, respond, h, prompt } = await setup();
    await respond({ turns: [{ text: ["one", " two", " three"], timing: { firstToken: 1000, betweenChunks: 500 } }] });
    vi.useFakeTimers({ toFake: ["Date"] });
    const before = h.timers.waiting();

    let started = false;
    const opened = client.responses
      .create({ model: "gpt-5", input: prompt, stream: true })
      .finally(() => (started = true));
    await until(() => h.timers.waiting() > before, "the stream to wait for its first token");
    h.timers.advance(999);
    await settle();
    const early = started;
    h.timers.advance(1);
    const stream = await opened;
    let text = "";
    const read = (async () => {
      for await (const event of stream) text += deltaOf("responses", event);
    })();
    const seen: string[] = [];
    for (const expected of ["one", "one two", "one two three"]) {
      await until(() => text === expected, `"${expected}"`);
      seen.push(text);
      if (expected === "one two three") break;
      await until(() => h.timers.waiting() > before, "the next chunk to be paced");
      h.timers.advance(499);
      await settle();
      seen.push(text);
      h.timers.advance(1);
    }
    await read;

    expect(early).toBe(false);
    expect(seen).toEqual(["one", "one", "one two", "one two", "one two three"]);
  });

  test("firstToken holds a scripted error too, counted from the call's arrival", async () => {
    const { client, respond, h, prompt } = await setup();
    await respond({ turns: [{ error: "content_policy", timing: { firstToken: 2000 } }] });
    // The server's clock moves only when the test moves it.
    vi.useFakeTimers({ toFake: ["Date"] });
    const before = h.timers.waiting();

    let refused = false;
    const answer = client.chat.completions
      .create({ model: "gpt-5", messages: ask(prompt) })
      .catch((caught: unknown) => caught)
      .finally(() => (refused = true));
    await until(() => h.timers.waiting() > before, "the error to wait for its first token");
    h.clock.advance(1999);
    h.timers.advance(1999);
    await settle();
    const early = refused;
    h.clock.advance(1);
    h.timers.advance(1);

    expect(await answer).toBeInstanceOf(BadRequestError);
    expect(early).toBe(false);
  });

  /** A responder script on the control API: the call held for it, once one is, and how to answer it. */
  async function responder(control: Awaited<ReturnType<typeof setup>>["control"], firstToken: number) {
    const { id } = await control("POST", "/scripts", { responder: true, timing: { firstToken } });
    const held = async () => {
      let calls: Array<{ id: string }> = [];
      await until(async () => {
        calls = (await control("GET", `/scripts/${id}/requests`)).held;
        return calls.length === 1;
      }, "the call to be held for the responder");
      return calls[0]?.id ?? "";
    };
    const answer = (heldId: string, text: string) =>
      control("POST", `/scripts/${id}/answers`, { held: heldId, turn: text });
    return { held, answer };
  }

  test("a responder's time counts toward firstToken: the answer waits only what is left", async () => {
    const { client, control, h, prompt } = await setup();
    const script = await responder(control, 1500);
    vi.useFakeTimers({ toFake: ["Date"] });

    let answered = false;
    const answer = client.chat.completions
      .create({ model: "gpt-5", messages: ask(prompt) })
      .finally(() => (answered = true));
    const held = await script.held();
    // The responder takes a second of the 1.5 seconds.
    h.clock.advance(1000);
    h.timers.advance(1000);
    await script.answer(held, "Two incidents yesterday.");
    await settle();
    const waited = answered;
    h.clock.advance(499);
    h.timers.advance(499);
    await settle();
    const early = answered;
    h.clock.advance(1);
    h.timers.advance(1);

    expect((await answer).choices[0]?.message.content).toBe("Two incidents yesterday.");
    expect(waited).toBe(false);
    expect(early).toBe(false);
  });

  test("a responder slower than firstToken is answered as soon as it answers", async () => {
    const { client, control, h, prompt } = await setup();
    const script = await responder(control, 800);
    vi.useFakeTimers({ toFake: ["Date"] });

    let answered = false;
    const answer = client.chat.completions
      .create({ model: "gpt-5", messages: ask(prompt) })
      .finally(() => (answered = true));
    const held = await script.held();
    h.clock.advance(1200);
    h.timers.advance(1200);
    await script.answer(held, "Two incidents yesterday.");

    // No time passes after the responder's answer: nothing is left of firstToken.
    await until(() => answered, "the answer, with no time passing");
    expect((await answer).choices[0]?.message.content).toBe("Two incidents yesterday.");
  });

  test.each(ENDPOINTS)(
    "%s: failAfter drop cuts the connection, and the SDK throws after the chunks it had",
    async (endpoint) => {
      const { client, respond, control, h, prompt } = await setup();
      await respond({ turns: [{ text: ["one", " two", " three"], failAfter: { chunks: 2, how: "drop" } }] });
      const before = h.timers.waiting();

      const stream = await callOn(client, endpoint, true, prompt);
      let text = "";
      const read = (async () => {
        for await (const event of stream as AsyncIterable<unknown>) text += deltaOf(endpoint, event);
      })().catch((caught: unknown) => caught);
      await until(() => text === "one two" && h.timers.waiting() > before, "the stream to be cut");
      h.timers.advance(50);
      const error = await read;

      expect(text).toBe("one two");
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(APIError);
      expect((error as Error).message).toMatch(/connection reset/);
      const [call] = await control("GET", "/calls");
      expect(call.response).toEqual(expect.objectContaining({ end: "dropped", chunksSent: 2 }));
    },
  );

  test.each(ENDPOINTS)(
    "%s: failAfter stall sends nothing more, the SDK waits, and the agent hanging up ends it",
    async (endpoint) => {
      const { client, respond, control, h, sessionId, prompt, hangUpChecks } = await setup();
      await respond({ turns: [{ text: ["one", " two", " three"], failAfter: { chunks: 2, how: "stall" } }] });
      const hangUp = new AbortController();

      const stream = await callOn(client, endpoint, true, prompt, { signal: hangUp.signal });
      let text = "";
      let ended = false;
      const read = (async () => {
        for await (const event of stream as AsyncIterable<unknown>) text += deltaOf(endpoint, event);
      })()
        .catch((caught: unknown) => caught)
        .finally(() => (ended = true));
      await until(() => text === "one two", "the chunks before the stall");
      h.timers.advance(10 * 60_000);
      await settle();
      const quiet = (await h.call("GET", `/sessions/${sessionId}/quiet`)).body;
      const stalled = { text, ended };
      hangUp.abort();
      // The check's copy of the stream hangs up with the agent, so the stream is cancelled at its source.
      await hangUpChecks();
      const error = await read;

      expect(stalled).toEqual({ text: "one two", ended: false });
      expect(quiet.open).toContain("a model stream that stalled after 2 chunks");
      expect(error === undefined || error instanceof APIUserAbortError).toBe(true);
      await until(async () => (await control("GET", "/calls"))[0]?.done === true, "the call to end");
      const [call] = await control("GET", "/calls");
      expect(call.response).toEqual(expect.objectContaining({ end: "stalled", chunksSent: 2 }));
    },
  );
});

const RATE_HEADERS = ["requests", "tokens"].flatMap((what) =>
  ["limit", "remaining", "reset"].map((part) => `x-ratelimit-${part}-${what}`),
);

describe("rate limits", () => {
  test("every answer carries the six x-ratelimit-* headers, and a session's model calls carry its limit's", async () => {
    const { client, respond, control, prompt, answers } = await setup();
    await respond({ turns: ["ok"], times: 4, when: { text: "deploy" } });
    await respond({ turns: [{ error: "overloaded", shouldRetry: false }], when: { text: "broken" } });
    await control("POST", "/rate-limits", {
      requests: { limit: 100, per: 60_000 },
      tokens: { limit: 100_000, per: 60_000 },
    });

    await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt) });
    for await (const _ of await client.chat.completions.create({
      model: "gpt-5",
      messages: ask(prompt),
      stream: true,
    }));
    const stored = await client.responses.create({ model: "gpt-5", input: prompt });
    for await (const _ of await client.responses.create({ model: "gpt-5", input: prompt, stream: true }));
    await client.chat.completions
      .create({ model: "gpt-5", messages: [...ask(prompt), { role: "user", content: "broken" }] })
      .catch(() => {});
    await client.responses.retrieve(stored.id);
    await client.responses.inputItems.list(stored.id);
    const conversation = await client.conversations.create({
      items: [{ type: "message", role: "user", content: "a note for later" }],
    });
    await client.conversations.items.list(conversation.id);
    await client.models.list();

    expect(answers.length).toBeGreaterThanOrEqual(10);
    for (const answer of answers) {
      for (const header of RATE_HEADERS) expect([answer.url, header, answer.headers.get(header)]).not.toContain(null);
    }
    // The model calls count against the session's limit, in order: errors and streams too.
    const model = answers.filter((answer) => answer.headers.get("x-ratelimit-limit-requests") === "100");
    expect(model.map((answer) => answer.headers.get("x-ratelimit-remaining-requests"))).toEqual([
      "99",
      "98",
      "97",
      "96",
      "95",
    ]);
  });

  test("a request limit refuses the call over it with OpenAI's message, type and headers, and frees up on the clock", async () => {
    const { client, respond, control, h, prompt } = await setup(undefined, { maxRetries: 0 });
    await respond({ turns: ["ok"], times: -1 });
    await control("POST", "/rate-limits", { requests: { limit: 1, per: 10_000 } });

    const first = await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt) }).withResponse();
    const refused = (await client.chat.completions
      .create({ model: "gpt-5", messages: ask(prompt) })
      .catch((caught: unknown) => caught)) as APIError;
    h.clock.advance(10_000);
    const later = await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt) });

    expect(first.response.headers.get("x-ratelimit-remaining-requests")).toBe("0");
    expect(refused).toBeInstanceOf(RateLimitError);
    expect(refused).toMatchObject({ status: 429, type: "requests", code: "rate_limit_exceeded" });
    const organization = refused.headers?.get("openai-organization");
    expect(organization).toMatch(/^org-[0-9A-Za-z]{24}$/);
    expect(refused.message).toMatch(
      new RegExp(
        `^429 Rate limit reached for gpt-5 in organization ${organization} on requests per min \\(RPM\\): Limit 1, Used 1, Requested 1\\. Please try again in \\d+(\\.\\d+)?s\\. Visit https://platform\\.openai\\.com/account/rate-limits to learn more\\.$`,
      ),
    );
    const waitMs = Number(refused.headers?.get("retry-after-ms"));
    expect(waitMs).toBeGreaterThan(9_000);
    expect(waitMs).toBeLessThanOrEqual(10_000);
    expect(refused.headers?.get("retry-after")).toBe("10");
    expect(refused.headers?.get("x-ratelimit-remaining-requests")).toBe("0");
    expect(refused.headers?.get("x-ratelimit-limit-requests")).toBe("1");
    expect(later.choices[0]?.message.content).toBe("ok");
  });

  test("a token limit counts the session's tokens, and refuses with type tokens and the TPM message", async () => {
    const { client, respond, control, h, prompt } = await setup(undefined, { maxRetries: 0 });
    await respond({ turns: ["ok"], times: -1 });
    await control("POST", "/rate-limits", { tokens: { limit: 15, per: 60_000 } });

    const first = await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt) }).withResponse();
    const remaining = Number(first.response.headers.get("x-ratelimit-remaining-tokens"));
    const used = 15 - remaining;
    const refused = (await client.chat.completions
      .create({ model: "gpt-5", messages: ask(prompt) })
      .catch((caught: unknown) => caught)) as APIError;
    h.clock.advance(60_000);
    const later = await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt) });

    expect(first.response.headers.get("x-ratelimit-limit-tokens")).toBe("15");
    expect(used).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(used);
    expect(refused).toBeInstanceOf(RateLimitError);
    expect(refused).toMatchObject({ status: 429, type: "tokens", code: "rate_limit_exceeded" });
    expect(refused.message).toContain(
      `on tokens per min (TPM): Limit 15, Used ${used}, Requested ${used}. Please try again in`,
    );
    expect(refused.headers?.get("x-ratelimit-remaining-tokens")).toBe(String(remaining));
    expect(Number(refused.headers?.get("retry-after-ms"))).toBeGreaterThan(50_000);
    expect(later.choices[0]?.message.content).toBe("ok");
  });

  test("a scripted rate_limit says the tier is used up until its retryAfter, in its message and headers", async () => {
    const { client, respond, prompt } = await setup(undefined, { maxRetries: 0 });
    await respond({ turns: [{ error: "rate_limit", retryAfter: "2s" }] });

    const refused = (await client.responses
      .create({ model: "gpt-5", input: prompt })
      .catch((caught: unknown) => caught)) as APIError;

    expect(refused).toMatchObject({ status: 429, type: "requests", code: "rate_limit_exceeded" });
    expect(refused.message).toContain(
      `Rate limit reached for gpt-5 in organization ${refused.headers?.get("openai-organization")} on requests per min (RPM)`,
    );
    expect(refused.message).toContain("Please try again in 2s.");
    expect(refused.headers?.get("retry-after")).toBe("2");
    expect(refused.headers?.get("retry-after-ms")).toBe("2000");
    expect(refused.headers?.get("x-ratelimit-remaining-requests")).toBe("0");
    expect(refused.headers?.get("x-ratelimit-reset-requests")).toBe("2s");
  });

  test("another session's calls don't count against a session's limit", async () => {
    const { client, respond, control, neighbour, prompt } = await setup(undefined, { maxRetries: 0 });
    await respond({ turns: ["ours"], times: -1 });
    await control("POST", "/rate-limits", { requests: { limit: 1, per: 60_000 } });
    const other = await neighbour();
    await other.control("POST", "/scripts", { turns: ["theirs"], times: -1 });

    const theirs = [];
    for (let call = 0; call < 3; call += 1) {
      theirs.push(
        await other.client.chat.completions
          .create({ model: "gpt-5", messages: ask("summarise the backlog") })
          .withResponse(),
      );
    }
    const ours = await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt) }).withResponse();
    const over = await client.chat.completions
      .create({ model: "gpt-5", messages: ask(prompt) })
      .catch((caught: unknown) => caught);

    expect(theirs.map(({ data }) => data.choices[0]?.message.content)).toEqual(["theirs", "theirs", "theirs"]);
    expect(theirs.map(({ response }) => response.headers.get("x-ratelimit-limit-requests"))).toEqual([
      "10000",
      "10000",
      "10000",
    ]);
    expect(ours.data.choices[0]?.message.content).toBe("ours");
    expect(ours.response.headers.get("x-ratelimit-remaining-requests")).toBe("0");
    expect(over).toBeInstanceOf(RateLimitError);
    expect(await other.control("GET", "/calls")).toHaveLength(3);
  });
});

describe("secrets sent to the model (exit check 13.10)", () => {
  test("every kind of secret channelstack knows is reported by its kind, and only its kind", async () => {
    const { client, respond, control, h, prompt } = await setup();
    await respond({ turns: ["ok"], times: -1 });
    const driverOf = new Map(DRIVERS.map((driver) => [driver.name, driver]));
    // The fakes' own secrets, by value; a live-shaped token of every format a driver knows, by shape; the control token.
    const planted: Array<{ secret: string; kinds: string[] }> = [
      ...Object.entries(secretSpecs()).flatMap(([driver, spec]) =>
        Object.keys(spec).map((name) => ({ secret: h.secrets.get(driver, name), kinds: [`${driver}.${name}`] })),
      ),
      ...PREFIXED_TOKENS.map(([name, format]) => ({
        secret: format.generate(),
        kinds: [`a ${driverOf.get(name.split(/[. ]/)[0] as string)?.title} token`],
      })),
      { secret: TOKEN, kinds: ["the control API's token"] },
    ];
    expect(planted.length).toBeGreaterThan(20);

    for (const { secret } of planted) {
      await client.chat.completions.create({
        model: "gpt-5",
        messages: [...ask(prompt), { role: "user", content: `the config says ${secret}` }],
      });
    }

    const calls: Array<{ id: string }> = await control("GET", "/calls");
    const sent: Array<{ call: string; kinds: string[] }> = await control("GET", "/sent-secrets");
    const kindsOf = new Map(sent.map((entry) => [entry.call, entry.kinds]));
    expect(calls).toHaveLength(planted.length);
    expect(calls.map((call, at) => ({ secret: at, kinds: kindsOf.get(call.id) ?? [] }))).toEqual(
      planted.map(({ kinds }, at) => ({ secret: at, kinds })),
    );
  });
});
