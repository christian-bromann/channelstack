import OpenAI from "openai";
import { afterEach, expect, vi } from "vitest";

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
  /** The check's readers of each stream, so a test can hang up on a stream the way an agent does. */
  let readers: Array<{ cancel(): Promise<void> }> = [];
  afterEach(async () => {
    vi.useRealTimers();
    await open?.agent.close();
    open = undefined;
    await Promise.race([Promise.allSettled(reading), new Promise((resolve) => setTimeout(resolve, 200))]);
    for (const reader of readers) await reader.cancel().catch(() => {});
    const found = problems;
    problems = [];
    reading = [];
    readers = [];
    expect(found).toEqual([]);
  });

  /** Hold an answer of the fake to OpenAI's description: its body, or each event of its stream that arrived whole. */
  function check(method: string, path: string, response: Response): Response {
    const copy = response.clone();
    if ((copy.headers.get("content-type") ?? "").startsWith("text/event-stream") && copy.body) {
      const reader = copy.body.getReader();
      readers.push(reader);
      const decoder = new TextDecoder();
      let text = "";
      const events = async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
        } finally {
          for (const event of text.split("\n\n").slice(0, -1)) {
            const data = event.split("\n").find((line) => line.startsWith("data: "));
            if (data === undefined || data === "data: [DONE]") continue;
            problems.push(...openaiStreamProblems(path, JSON.parse(data.slice(6)) as Record<string, unknown>));
          }
        }
      };
      reading.push(events().catch(() => {}));
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

  /** An OpenAI client on the fake in process, the way an agent has one; every answer it gets is kept in `answers`. */
  function clientOn(h: Workspace["h"], answers: Response[], options: ConstructorParameters<typeof OpenAI>[0] = {}) {
    return new OpenAI({
      apiKey: h.secrets.get("openai", "apiKey"),
      baseURL: "http://127.0.0.1:4500/openai/v1",
      fetch: async (input, init) => {
        const request = new Request(input as string, init as RequestInit);
        // The SDK probes `fetch("data:,")` before a multipart upload: that isn't the fake's.
        if (!request.url.startsWith("http://127.0.0.1:4500/")) return fetch(request);
        const response = check(request.method, new URL(request.url).pathname, await h.app.fetch(request));
        answers.push(response);
        return response;
      },
      ...options,
    });
  }

  /** A Slack workspace where Ana said `prompt`, and an OpenAI client on the fake, the way an agent has one. */
  async function setup(
    prompt = "what broke in the web deploy yesterday?",
    options: ConstructorParameters<typeof OpenAI>[0] = {},
  ) {
    const workspace = await slackWorkspace();
    open = workspace;
    await workspace.say(prompt);
    const { h, sessionId } = workspace;
    const answers: Response[] = [];
    const client = clientOn(h, answers, options);
    const controlOf = (session: string) => async (method: string, path: string, body?: unknown) => {
      const response = await h.call(method, `/sessions/${session}/openai${path}`, body);
      if (response.status >= 400) throw Object.assign(new Error(response.body.message), response);
      return response.body;
    };
    const control = controlOf(sessionId);
    const respond = (body: Record<string, unknown>) => control("POST", "/scripts", body);
    /** Another test's session in the same server, and a client whose calls it claims by their tag. */
    const neighbour = async () => {
      const { sessionId: id } = (await h.call("POST", "/sessions")).body;
      return {
        sessionId: id as string,
        control: controlOf(id),
        client: clientOn(h, answers, { defaultHeaders: { "x-channelstack-session": id } }),
      };
    };
    /** The check's copies of the streams hang up, as the agent's own reading would. */
    const hangUpChecks = async () => {
      for (const reader of readers) await reader.cancel().catch(() => {});
    };
    return { ...workspace, client, control, respond, prompt, answers, neighbour, hangUpChecks };
  }
  return setup;
}
