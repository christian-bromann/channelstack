import OpenAI from "openai";
import { afterEach, expect } from "vitest";

import { openaiResponseProblems, openaiStreamProblems } from "./schemas/openai.ts";
import { slackWorkspace } from "./slack-workspace.ts";

/**
 * The fake OpenAI in a unit test: a Slack workspace where Ana said something, and the official
 * `openai` SDK on the fake in process, the way an agent has it. Every answer and stream event
 * the test gets is held to OpenAI's pinned description, and the test fails on any difference
 * (exit check 13.2). Call `useOpenAIWorkspace()` once in a test file; `setup()` in each test.
 */
export function useOpenAIWorkspace() {
  type Workspace = Awaited<ReturnType<typeof slackWorkspace>>;
  let open: Workspace | undefined;
  /** What OpenAI's description says about the answers and stream events of this test (exit check 13.2). */
  let problems: string[] = [];
  /** Streams still being read for the check: one that stalled or was cut is read as far as it went. */
  let reading: Promise<void>[] = [];
  afterEach(async () => {
    await open?.agent.close();
    open = undefined;
    await Promise.race([Promise.allSettled(reading), new Promise((resolve) => setTimeout(resolve, 200))]);
    const found = problems;
    problems = [];
    reading = [];
    expect(found).toEqual([]);
  });

  /** Hold an answer of the fake to OpenAI's description: its body, or each event of its stream. */
  function check(method: string, path: string, response: Response): Response {
    const copy = response.clone();
    if ((copy.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
      reading.push(
        copy
          .text()
          .then((text) => {
            for (const line of text.split("\n")) {
              if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
              problems.push(...openaiStreamProblems(path, JSON.parse(line.slice(6)) as Record<string, unknown>));
            }
          })
          .catch(() => {}),
      );
    } else {
      reading.push(
        copy
          .json()
          .then((body: unknown) => {
            problems.push(...openaiResponseProblems(method, path, response.status, body));
          })
          .catch(() => {}),
      );
    }
    return response;
  }

  /** A Slack workspace where Ana said `prompt`, and an OpenAI client on the fake, the way an agent has one. */
  async function setup(prompt = "what broke in the web deploy yesterday?") {
    const workspace = await slackWorkspace();
    open = workspace;
    await workspace.say(prompt);
    const { h, sessionId } = workspace;
    const client = new OpenAI({
      apiKey: h.secrets.get("openai", "apiKey"),
      baseURL: "http://127.0.0.1:4500/openai/v1",
      fetch: async (input, init) => {
        const request = new Request(input as string, init as RequestInit);
        // The SDK probes `fetch("data:,")` before a multipart upload: that isn't the fake's.
        if (!request.url.startsWith("http://127.0.0.1:4500/")) return fetch(request);
        return check(request.method, new URL(request.url).pathname, await h.app.fetch(request));
      },
    });
    const control = async (method: string, path: string, body?: unknown) => {
      const response = await h.call(method, `/sessions/${sessionId}/openai${path}`, body);
      if (response.status >= 400) throw Object.assign(new Error(response.body.message), response);
      return response.body;
    };
    const respond = (body: Record<string, unknown>) => control("POST", "/scripts", body);
    return { ...workspace, client, control, respond, prompt };
  }
  return setup;
}
