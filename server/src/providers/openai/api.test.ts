/**
 * The fake OpenAI's HTTP API and control API on the edges the SDK tests don't reach: every
 * endpoint on the record, secrets kept out of what the control API returns, scripts that follow
 * one another, templates in tool arguments, calls the agent abandons, SDK retries between two
 * sessions that sent the same text, tool results without their call, and Chat Completions'
 * obfuscation.
 */
import OpenAI, { APIError } from "openai";
import { afterEach, describe, expect, test } from "vitest";

import type { Harness } from "../../../test/app-harness.ts";
import { slackWorkspace } from "../../../test/slack-workspace.ts";

type Workspace = Awaited<ReturnType<typeof slackWorkspace>>;
let open: Workspace | undefined;
afterEach(async () => {
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
