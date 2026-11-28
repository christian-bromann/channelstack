/**
 * The fake OpenAI's HTTP API and control API on the edges the SDK tests don't reach: every
 * endpoint on the record, secrets kept out of what the control API returns, scripts that follow
 * one another, templates in tool arguments, calls the agent abandons, SDK retries between two
 * sessions that sent the same text, strict schemas that aren't JSON Schema, a call the fake fails
 * on, tool results whose call is a reference or missing, and Chat Completions' obfuscation.
 */
import OpenAI, { type APIError } from "openai";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { Harness } from "../../../test/app-harness.ts";
import { slackWorkspace } from "../../../test/slack-workspace.ts";
import { Scripts } from "./scripts.ts";

type Workspace = Awaited<ReturnType<typeof slackWorkspace>>;
let open: Workspace | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await open?.agent.close();
  open = undefined;
});

const BASE = "http://127.0.0.1:4500/openai/v1";

/** An OpenAI client on the fake, the way an agent has one. */
const clientOf = (h: Harness) =>
  new OpenAI({
    apiKey: h.secrets.get("openai", "apiKey"),
    baseURL: BASE,
    fetch: async (input, init) => h.app.fetch(new Request(input as string, init as RequestInit)),
  });

/** The control API of one session's fake model. */
const controlOf = (h: Harness, sessionId: string) => async (method: string, path: string, body?: unknown) => {
  const response = await h.call(method, `/sessions/${sessionId}/openai${path}`, body);
  if (response.status >= 400) throw Object.assign(new Error(response.body.message), response);
  return response.body;
};

async function setup(prompt = "what broke in the web deploy yesterday?") {
  const workspace = await slackWorkspace();
  open = workspace;
  await workspace.say(prompt);
  const { h, sessionId } = workspace;
  const control = controlOf(h, sessionId);
  const respond = (body: Record<string, unknown>) => control("POST", "/scripts", body);
  return { ...workspace, client: clientOf(h), control, respond, prompt };
}

/** A second session on the same server, where its own Ana said `prompt` in a channel with the app. */
async function anotherSession(h: Harness, appId: string, prompt: string) {
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const slack = async (path: string, body: unknown) =>
    (await h.call("POST", `/sessions/${sessionId}/slack${path}`, body)).body;
  const ana = await slack("/users", { name: "Ana" });
  const channel = await slack("/channels", { participants: [ana.id, appId] });
  await slack(`/users/${ana.id}/say`, { message: { text: prompt }, channel: channel.id });
  return { sessionId, control: controlOf(h, sessionId) };
}

const ask = (prompt: string) => [{ role: "user" as const, content: prompt }];

/** A Chat Completions request as the SDK sends it, attempt `retry` of it (`x-stainless-retry-count`). */
const attemptOf = (h: Harness, body: unknown, retry = 0) =>
  h.app.fetch(
    new Request(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${h.secrets.get("openai", "apiKey")}`,
        "content-type": "application/json",
        "x-stainless-retry-count": String(retry),
      },
      body: JSON.stringify(body),
    }),
  );

/** The fake model's calls in a session's event log, as `channelstack tail` and the inspector read them. */
async function recorded(h: Harness, sessionId: string) {
  const { events } = (await h.call("GET", `/sessions/${sessionId}/events`)).body as {
    events: Array<{ driver: string; kind: string; data: Record<string, unknown> }>;
  };
  return events.filter((event) => event.kind === "api_call" && event.driver === "openai").map((event) => event.data);
}

describe("every endpoint is on the record", () => {
  test("stored responses and conversations go on record for their session, beside the model calls", async () => {
    const { h, sessionId, client, respond, prompt } = await setup();
    await respond({ turns: ["Two incidents.", "And a DNS blip."] });

    const response = await client.responses.create({ model: "gpt-5", input: prompt });
    await client.responses.retrieve(response.id);
    await client.responses.inputItems.list(response.id);
    const conversation = await client.conversations.create({});
    await client.responses.create({ model: "gpt-5", input: prompt, conversation: conversation.id });
    await client.conversations.retrieve(conversation.id);
    await client.conversations.items.list(conversation.id);
    await client.responses.delete(response.id);

    const calls = await recorded(h, sessionId);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "responses", method: "POST", path: "/v1/responses", responseStatus: 200 }),
        expect.objectContaining({ method: "GET", path: `/v1/responses/${response.id}`, responseStatus: 200 }),
        expect.objectContaining({ method: "GET", path: `/v1/responses/${response.id}/input_items` }),
        expect.objectContaining({
          method: "GET",
          path: `/v1/conversations/${conversation.id}`,
          response: expect.objectContaining({ id: conversation.id }),
        }),
        expect.objectContaining({ method: "GET", path: `/v1/conversations/${conversation.id}/items` }),
        expect.objectContaining({ method: "DELETE", path: `/v1/responses/${response.id}`, responseStatus: 200 }),
      ]),
    );
  });

  test("a refusal keeps OpenAI's headers, and a call without the key is refused and kept off the record", async () => {
    const { h, sessionId, client, respond, control, prompt } = await setup();
    await respond({ turns: ["ok"], times: -1 });
    await control("POST", "/rate-limits", { requests: { limit: 1, per: 10_000 } });

    await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt) });
    const refused = (await client.chat.completions
      .create({ model: "gpt-5", messages: ask(prompt) }, { maxRetries: 0 })
      .catch((caught: unknown) => caught)) as APIError;
    const keyless = await h.provider("GET", "openai/v1/models", undefined, null);

    expect(refused.status).toBe(429);
    expect(refused.headers?.get("retry-after-ms")).toMatch(/^\d+$/);
    expect(refused.headers?.get("x-request-id")).toMatch(/^req_/);
    expect(keyless.status).toBe(401);
    expect((await recorded(h, sessionId)).filter((call) => call.responseStatus === 401)).toEqual([]);
  });
});

describe("secrets never come back from the control API", () => {
  test("a token in a tool result, an unanswered prompt or an unattributed call is scrubbed everywhere", async () => {
    const { h, sessionId, client, respond, control, app, prompt } = await setup();
    const token = app.botToken as string;
    await respond({ turns: [{ toolCalls: [{ name: "lookup", arguments: {} }] }], when: { toolResult: false } });

    const first = await client.chat.completions.create({
      model: "gpt-5",
      messages: ask(prompt),
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    });
    const call = first.choices[0]?.message.tool_calls?.[0];
    // The tool's result holds the token; nothing answers it, so it is a problem quoting the prompt.
    await client.chat.completions
      .create({
        model: "gpt-5",
        messages: [
          ...ask(`${prompt} ${token}`),
          { role: "assistant", content: null, tool_calls: call ? [call] : [] },
          { role: "tool", tool_call_id: call?.id ?? "", content: `the token is ${token}` },
        ],
      })
      .catch(() => undefined);
    await client.chat.completions
      .create({ model: "gpt-5", messages: ask(`summarise the backlog every morning ${token}`) })
      .catch(() => undefined);

    const read = JSON.stringify([
      await control("GET", "/calls"),
      await control("GET", "/tool-calls"),
      await control("GET", "/problems"),
      await control("GET", "/unattributed"),
      (await h.call("GET", `/sessions/${sessionId}/quiet`)).body,
    ]);
    expect(read).toContain("the token is");
    expect(read).toContain("summarise the backlog");
    expect(read).not.toContain(token);
  });
});

describe("a secret where a quote of the agent's text is cut", () => {
  test("is scrubbed whole before the cut: nothing of it on /problems, /quiet, /unattributed or the record", async () => {
    const { h, sessionId, client, control, prompt } = await setup();
    const secret = h.secrets.get("slack", "signingSecret");
    // The newest user message is quoted to 80 characters (cut at 77), an unattributed call's to 200:
    // a 32-character secret across each cut.
    const attributed = `${prompt} use this: ${secret} please`;
    const early = `summarise the backlog every morning, with ${secret} please`;
    const late = `summarise the backlog every morning ${"and the night before ".repeat(7)}with ${secret} please`;
    expect(attributed.indexOf(secret)).toBeLessThan(77);
    expect(attributed.indexOf(secret) + secret.length).toBeGreaterThan(77);
    expect(early.indexOf(secret)).toBeLessThan(77);
    expect(late.indexOf(secret)).toBeLessThan(200);
    expect(late.indexOf(secret) + secret.length).toBeGreaterThan(200);

    for (const text of [attributed, early, late]) {
      await client.chat.completions.create({ model: "gpt-5", messages: ask(text) }, { maxRetries: 0 }).catch(() => {});
    }

    const read = JSON.stringify([
      await control("GET", "/problems"),
      await control("GET", "/unattributed"),
      (await h.call("GET", `/sessions/${sessionId}/quiet`)).body,
      await recorded(h, sessionId),
    ]);
    expect(read).toContain("use this: [redacted]");
    expect(read).toContain("summarise the backlog every morning");
    for (let at = 0; at + 8 <= secret.length; at += 1) expect(read).not.toContain(secret.slice(at, at + 8));
  });
});

describe("scripts in sequence", () => {
  test("a script that ran out is no problem when a later one answers the call", async () => {
    const { client, respond, control, prompt } = await setup();
    await respond({ turns: ["first"] });
    await respond({ turns: ["follow-up"] });

    const one = await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt) });
    const two = await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt) });

    expect(one.choices[0]?.message.content).toBe("first");
    expect(two.choices[0]?.message.content).toBe("follow-up");
    expect(await control("GET", "/problems")).toEqual([]);
  });
});

describe("templates in tool arguments", () => {
  test("a user message with quotes, a backslash and a newline fills arguments that are still JSON", async () => {
    const prompt = 'what does "deploy" mean in C:\\web?\nasking for a friend';
    const { client, respond } = await setup(prompt);
    await respond({ turns: [{ toolCalls: [{ name: "search", arguments: { q: "{lastUserText}", n: 3 } }] }] });

    const answer = await client.chat.completions.create({
      model: "gpt-5",
      messages: ask(prompt),
      tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }],
    });

    const args = answer.choices[0]?.message.tool_calls?.[0];
    expect(JSON.parse(args?.type === "function" ? args.function.arguments : "null")).toEqual({ q: prompt, n: 3 });
  });
});

describe("a call the agent abandons", () => {
  test("a non-streamed call cancelled before its first token is aborted, and its response isn't stored", async () => {
    const { h, client, respond, control, prompt } = await setup();
    await respond({ turns: [{ text: "Too late.", timing: { firstToken: "5s" } }] });
    const stop = new AbortController();

    const pending = h.app.fetch(
      new Request(`${BASE}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${h.secrets.get("openai", "apiKey")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5", input: prompt }),
        signal: stop.signal,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop.abort();
    await pending;
    h.timers.advance(5_000);

    const [call] = await control("GET", "/calls");
    expect(call.response).toMatchObject({ aborted: true, end: "aborted" });
    expect(call.response.status).not.toBe(200);
    const stored = await client.responses.retrieve(call.id).catch((caught: unknown) => caught);
    expect((stored as APIError).status).toBe(404);
  });
});

describe("an SDK retry", () => {
  test("goes to the session its first attempt went to, even when another session sent the same text", async () => {
    const prompt = "how is my change doing today?";
    const { h, client, respond, app } = await setup(prompt);
    const other = await anotherSession(h, app.id as string, prompt);
    await respond({ turns: [{ error: "server_error" }, "Yours is green."] });
    await other.control("POST", "/scripts", { turns: ["The other session's answer."] });

    const answer = await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt) }, { maxRetries: 1 });

    expect(answer.choices[0]?.message.content).toBe("Yours is green.");
    expect(await other.control("GET", "/calls")).toEqual([]);
  });

  test("goes to its own session when the other session's identical first attempt came before it", async () => {
    const prompt = "how is my change doing today?";
    const { h, control, respond, app } = await setup(prompt);
    const other = await anotherSession(h, app.id as string, prompt);
    await respond({ turns: [{ error: "server_error" }, "Yours is green."] });
    await other.control("POST", "/scripts", { turns: ["The other session's answer."] });
    const body = { model: "gpt-5", messages: ask(prompt) };

    // This session's first attempt fails; the other's, the same body, comes while the SDK waits to retry.
    const failed = await attemptOf(h, body, 0);
    const theirs = await attemptOf(h, body, 0);
    const retried = await attemptOf(h, body, 1);

    const textOf = async (response: Response) =>
      ((await response.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content;
    expect(failed.status).toBe(500);
    expect(await textOf(theirs)).toBe("The other session's answer.");
    expect(await textOf(retried)).toBe("Yours is green.");
    expect((await control("GET", "/calls")).map((call: { attempt: number }) => call.attempt)).toEqual([0, 1]);
    expect(await other.control("GET", "/calls")).toHaveLength(1);
  });
});

describe("a strict schema that isn't JSON Schema", () => {
  test("is refused as OpenAI refuses it, a 400 naming the function, and the SDK doesn't retry it", async () => {
    const { client, control, respond, prompt } = await setup();
    const script = await respond({ turns: [{ toolCalls: [{ name: "lookup", arguments: { q: "deploy" } }] }] });
    const parameters = {
      type: "object",
      properties: { q: { type: "strin" } },
      required: ["q"],
      additionalProperties: false,
    };

    const chat = (await client.chat.completions
      .create({
        model: "gpt-5",
        messages: ask(prompt),
        tools: [{ type: "function", function: { name: "lookup", strict: true, parameters } }],
      })
      .catch((caught: unknown) => caught)) as APIError;
    const responses = (await client.responses
      .create({
        model: "gpt-5",
        input: prompt,
        tools: [{ type: "function", name: "lookup", strict: true, parameters }],
      })
      .catch((caught: unknown) => caught)) as APIError;

    for (const [error, param] of [
      [chat, "tools[0].function.parameters"],
      [responses, "tools[0].parameters"],
    ] as const) {
      expect(error.status).toBe(400);
      expect(error.type).toBe("invalid_request_error");
      expect(error.code).toBe("invalid_function_parameters");
      expect(error.param).toBe(param);
      expect(error.message).toMatch(/^400 Invalid schema for function 'lookup': .+\.$/);
    }
    // Refused before it was a model call: nothing in flight, and the script still has its turn.
    expect(await control("GET", "/calls")).toEqual([]);
    expect((await control("GET", `/scripts/${script.id}`)).used).toBe(0);
  });

  test("a strict response format that isn't JSON Schema is refused the same way", async () => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: ['{"q":"deploy"}'] });

    const error = (await client.chat.completions
      .create({
        model: "gpt-5",
        messages: ask(prompt),
        response_format: {
          type: "json_schema",
          json_schema: { name: "answer", strict: true, schema: { type: "object", properties: { q: { type: 7 } } } },
        },
      })
      .catch((caught: unknown) => caught)) as APIError;

    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_json_schema");
    expect(error.param).toBe("response_format");
    expect(error.message).toMatch(/^400 Invalid schema for response_format 'answer': /);
  });
});

describe("a model call the fake fails on", () => {
  test("ends: on record with its 500, not in flight, and a problem of its session", async () => {
    const { h, sessionId, client, control, respond, prompt } = await setup();
    await respond({ turns: ["ok"] });
    vi.spyOn(Scripts.prototype, "problemsOf").mockImplementation(() => {
      throw new Error("a bug in the fake");
    });

    const error = (await client.chat.completions
      .create({ model: "gpt-5", messages: ask(prompt) }, { maxRetries: 0 })
      .catch((caught: unknown) => caught)) as APIError;

    expect(error.status).toBe(500);
    const [call] = await control("GET", "/calls");
    expect(call).toMatchObject({ done: true, response: { status: 500, error: "server_error" } });
    expect(JSON.stringify((await h.call("GET", `/sessions/${sessionId}/quiet`)).body)).not.toContain("model call");
    expect(await control("GET", "/problems")).toEqual([
      expect.stringMatching(/^the fake OpenAI failed answering chatcmpl-\w+: a bug in the fake$/),
    ]);
    expect(await recorded(h, sessionId)).toEqual([expect.objectContaining({ responseStatus: 500 })]);
  });
});

describe("a tool result whose call is an item_reference", () => {
  test("Responses finds the stored call the reference names, as OpenAI does", async () => {
    const { client, respond, prompt } = await setup();
    await respond({
      turns: [{ toolCalls: [{ name: "lookup", arguments: { q: "deploy" } }] }, "Found it: {toolResult}"],
    });
    const tools = [{ type: "function" as const, name: "lookup", strict: false, parameters: { type: "object" } }];

    const first = await client.responses.create({ model: "gpt-5", input: prompt, tools });
    const call = first.output.find((item) => item.type === "function_call");
    const answer = await client.responses.create({
      model: "gpt-5",
      tools,
      input: [
        { role: "user", content: prompt },
        { type: "item_reference", id: call?.id ?? "" },
        { type: "function_call_output", call_id: call?.call_id ?? "", output: "run 7 failed" },
      ],
    });

    expect(answer.output_text).toBe("Found it: run 7 failed");
  });

  test("a reference to an item the fake doesn't keep finds no call", async () => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: ["ok"] });

    const error = (await client.responses
      .create({
        model: "gpt-5",
        input: [
          { role: "user", content: prompt },
          { type: "item_reference", id: "fc_unknown" },
          { type: "function_call_output", call_id: "call_unknown", output: "42" },
        ],
      })
      .catch((caught: unknown) => caught)) as APIError;

    expect(error.status).toBe(400);
    expect(error.message).toMatch(/No tool call found for function call output with call_id call_unknown\./);
  });
});

describe("a tool result without its call", () => {
  test("Responses refuses a function_call_output whose call isn't in the input, as OpenAI does", async () => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: ["ok"] });

    const error = (await client.responses
      .create({
        model: "gpt-5",
        input: [
          { role: "user", content: prompt },
          { type: "function_call_output", call_id: "call_dropped", output: "42" },
        ],
      })
      .catch((caught: unknown) => caught)) as APIError;

    expect(error.status).toBe(400);
    expect(error.message).toMatch(/No tool call found for function call output with call_id call_dropped\./);
    expect(error.param).toBe("input");
    expect(error.type).toBe("invalid_request_error");
  });

  test("Chat Completions refuses tool calls the conversation goes on without answering, as OpenAI does", async () => {
    const { client, respond, prompt } = await setup();
    await respond({ turns: ["ok"], times: -1 });
    const called = {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        { id: "call_answered", type: "function" as const, function: { name: "lookup", arguments: "{}" } },
        { id: "call_dropped", type: "function" as const, function: { name: "lookup", arguments: "{}" } },
      ],
    };
    const refusal = (messages: Parameters<typeof client.chat.completions.create>[0]["messages"]) =>
      client.chat.completions
        .create({ model: "gpt-5", messages }, { maxRetries: 0 })
        .catch((caught: unknown) => caught) as Promise<APIError>;

    for (const messages of [
      // The conversation goes on past the call.
      [...ask(prompt), called, { role: "tool" as const, tool_call_id: "call_answered", content: "1" }, ...ask("and?")],
      // It ends on the call.
      [...ask(prompt), called],
    ]) {
      const error = await refusal(messages);
      expect(error.status).toBe(400);
      expect(error.message).toMatch(
        /An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'\. The following tool_call_ids did not have response messages: (call_answered, )?call_dropped$/,
      );
      expect(error.param).toBe("messages[1].role");
      expect(error.type).toBe("invalid_request_error");
    }

    // Both answered, the call goes through.
    const answered = await client.chat.completions.create({
      model: "gpt-5",
      messages: [
        ...ask(prompt),
        called,
        { role: "tool", tool_call_id: "call_answered", content: "1" },
        { role: "tool", tool_call_id: "call_dropped", content: "2" },
      ],
    });
    expect(answered.choices[0]?.message.content).toBe("ok");
  });
});

describe("Chat Completions' obfuscation", () => {
  const stream = async (h: Harness, prompt: string, options: Record<string, unknown>) => {
    const response = await h.app.fetch(
      new Request(`${BASE}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${h.secrets.get("openai", "apiKey")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5", messages: ask(prompt), stream: true, ...options }),
      }),
    );
    return (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  };

  test("every chunk carries it by default, and none with include_obfuscation: false", async () => {
    const { h, respond, prompt } = await setup();
    await respond({ turns: ["Two incidents.", "Two incidents."] });

    const padded = await stream(h, prompt, { stream_options: { include_usage: true } });
    const plain = await stream(h, prompt, { stream_options: { include_obfuscation: false } });

    expect(padded.length).toBeGreaterThan(2);
    for (const chunk of padded) expect(chunk.obfuscation).toEqual(expect.any(String));
    for (const chunk of plain) expect(chunk).not.toHaveProperty("obfuscation");
  });
});

describe("how a call was attributed, on its wire", () => {
  test("a call attributed by order names the sessions it tied with and the text they shared", async () => {
    const prompt = "how is my change doing today?";
    const { h, sessionId, client, respond, control, app } = await setup(prompt);
    const other = await anotherSession(h, app.id as string, prompt);
    await respond({ turns: ["Yours is green."] });

    await client.chat.completions.create({ model: "gpt-5", messages: ask(prompt) });

    const [call] = await control("GET", "/calls");
    expect(call.request.context).toMatchObject({
      attributedBy: "order",
      tiedWith: [other.sessionId],
      matched: "how is my change doing today?",
    });
    expect(call.request.context.tiedWith).not.toContain(sessionId);
  });

  test("an unattributed call says what the agent was told and how long ago it came", async () => {
    const { client, control, h } = await setup();

    await client.chat.completions
      .create({ model: "gpt-5", messages: ask("summarise the backlog every morning") })
      .catch(() => undefined);
    h.clock.advance(3_000);

    const [call] = await control("GET", "/unattributed");
    expect(call).toMatchObject({
      lastUserText: "summarise the backlog every morning",
      message: expect.stringMatching(/couldn't be attributed to any test/),
    });
    expect(call.sinceMs).toBeGreaterThanOrEqual(3_000);
    expect(await control("GET", "/unattributed?withinMs=1000")).toEqual([]);
  });
});

describe("undoing a script", () => {
  test("a script the session doesn't have is not_found", async () => {
    const { h, sessionId } = await setup();

    const response = await h.call("DELETE", `/sessions/${sessionId}/openai/scripts/ms_unknown`);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("not_found");
  });
});
