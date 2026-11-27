/**
 * The fake OpenAI against the official `openai` SDK, in process (exit checks 13.3, 13.4, 13.7,
 * 13.8 and 13.11): every turn kind on both endpoints, streamed and not, the errors and the SDK's
 * retries, scripts that run out, and the store behind `previous_response_id` and conversations.
 */
import OpenAI, { APIError } from "openai";
import { afterEach, describe, expect, test } from "vitest";

import { slackWorkspace } from "../../../test/slack-workspace.ts";

type Workspace = Awaited<ReturnType<typeof slackWorkspace>>;
let open: Workspace | undefined;
afterEach(async () => {
  await open?.agent.close();
  open = undefined;
});

/** A Slack workspace where Ana said `prompt`, and an OpenAI client on the fake, the way an agent has one. */
async function setup(prompt = "what broke in the web deploy yesterday?") {
  const workspace = await slackWorkspace();
  open = workspace;
  await workspace.say(prompt);
  const { h, sessionId } = workspace;
  const client = new OpenAI({
    apiKey: h.secrets.get("openai", "apiKey"),
    baseURL: "http://127.0.0.1:4500/openai/v1",
    fetch: (input, init) => Promise.resolve(h.app.fetch(new Request(input as string, init as RequestInit))),
  });
  const control = async (method: string, path: string, body?: unknown) => {
    const response = await h.call(method, `/sessions/${sessionId}/openai${path}`, body);
    if (response.status >= 400) throw Object.assign(new Error(response.body.message), response);
    return response.body;
  };
  const respond = (body: Record<string, unknown>) => control("POST", "/scripts", body);
  return { ...workspace, client, control, respond, prompt };
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

  test("each documented error comes with OpenAI's status, type and code", async () => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: [{ error: "project_spend_limit_exceeded", shouldRetry: false }] });

    const error = (await client.chat.completions
      .create({ model: "gpt-5", messages: ask(prompt) }, { maxRetries: 0 })
      .catch((caught: unknown) => caught)) as APIError;

    expect(error.status).toBe(429);
    expect(error.type).toBe("insufficient_quota");
    expect(error.code).toBe("project_spend_limit_exceeded");
  });

  test("a rate limit counts the session's calls, and frees up on the clock", async () => {
    const { client, respond, control, h, prompt } = await setup();
    await respond({ turns: ["ok"], times: -1 });
    await control("POST", "/rate-limits", { requests: { limit: 1, per: 10_000 } });

    const first = await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt) }).withResponse();
    const refused = (await client.chat.completions
      .create({ model: "gpt-5", messages: ask(prompt) }, { maxRetries: 0 })
      .catch((caught: unknown) => caught)) as APIError;
    h.clock.advance(10_000);
    const later = await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt) });

    expect(first.response.headers.get("x-ratelimit-limit-requests")).toBe("1");
    expect(refused.status).toBe(429);
    expect(refused.code).toBe("rate_limit_exceeded");
    expect(Number(refused.headers?.get("retry-after-ms"))).toBeGreaterThan(0);
    expect(later.choices[0]?.message.content).toBe("ok");
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
