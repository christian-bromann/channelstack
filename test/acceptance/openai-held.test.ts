import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { binaryPath } from "../../scripts/lib/packages.ts";
import { startBinary } from "../../scripts/lib/server.ts";

/** Longer than the 10s an HTTP server may let a connection sit without a byte before it cuts it. */
const HELD_MS = 14_000;

describe("a model call held longer than 10s stays open through the server (13.7)", () => {
  let server: Awaited<ReturnType<typeof startBinary>>;
  const control = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${server.url}/_channelstack${path}`, {
      method,
      headers: {
        authorization: `Bearer ${server.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (response.status >= 400) throw new Error(`${method} ${path}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
  beforeAll(async () => {
    server = await startBinary({
      bin: process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath(),
      env: { CHANNELSTACK_LOG_LEVEL: "warn" },
    });
  }, 30_000);
  afterAll(async () => {
    await server?.stop();
  });

  // Through the compiled server's own listener, not the app in process: a paused stream and a
  // slow first token send nothing for longer than an idle connection may last, and neither is cut.
  test("a stream paused at pauseAfter and a call waiting for its first token are neither cut nor aborted", async () => {
    const { sessionId: session } = await control("POST", "/sessions");
    const env = await control("GET", "/env");
    const paused = await control("POST", `/sessions/${session}/openai/scripts`, {
      turns: [{ text: ["one", " two", " three"], pauseAfter: 1 }],
      when: { stream: true },
    });
    await control("POST", `/sessions/${session}/openai/scripts`, {
      turns: [{ text: "late but whole", timing: { firstToken: `${HELD_MS - 1000}ms` } }],
      when: { stream: false },
    });
    const call = (stream: boolean) =>
      fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5",
          user: session,
          stream,
          messages: [{ role: "user", content: "how is the deploy going?" }],
        }),
      });

    const started = performance.now();
    const [streamed, slow] = [call(true), call(false)];
    const stream = await streamed;
    expect(stream.status).toBe(200);
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    await new Promise((resolve) => setTimeout(resolve, HELD_MS - (performance.now() - started)));

    const answered = await slow;
    expect(answered.status).toBe(200);
    const body = (await answered.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("late but whole");
    const [held] = await control("GET", `/sessions/${session}/openai/scripts/${paused.id}/calls`);
    expect(held).toMatchObject({ done: false, response: { aborted: false } });

    await control("POST", `/sessions/${session}/openai/scripts/${paused.id}/resume`);
    for (let read = await reader.read(); !read.done; read = await reader.read()) text += decoder.decode(read.value);
    expect(text).toContain("three");
    expect(text).toContain("data: [DONE]");
    const [ended] = await control("GET", `/sessions/${session}/openai/scripts/${paused.id}/calls`);
    expect(ended).toMatchObject({ done: true, response: { status: 200, aborted: false, end: "completed" } });
    await control("DELETE", `/sessions/${session}`);
  }, 40_000);
});
