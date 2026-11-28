/**
 * The agent's side of a model call, for the stand-ins that play the agent themselves: a Chat
 * Completions request through `fetch`, as the official SDKs send it.
 */

/** What a played agent sends: the newest user message, the tools it offers, and an optional tag. */
export interface ModelCall {
  readonly text: string;
  readonly tools?: readonly string[];
  /** A tag the fake attributes the call by (`user`): the test's session id. Without it, the text decides. */
  readonly user?: string;
}

/** What came back, and how long it took. */
export interface ModelAnswer {
  readonly status: number;
  readonly body: {
    choices?: Array<{ message: { content: string | null } }>;
    error?: { code: string; message: string };
  };
  readonly ms: number;
}

/** Make the call against the fake OpenAI at `baseUrl`, with the key `channelstack env` printed. */
export async function callModel(baseUrl: string, key: string, call: ModelCall): Promise<ModelAnswer> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5",
      ...(call.user === undefined ? {} : { user: call.user }),
      messages: [{ role: "user", content: call.text }],
      ...(call.tools === undefined
        ? {}
        : {
            tools: call.tools.map((name) => ({ type: "function", function: { name, parameters: { type: "object" } } })),
          }),
    }),
  });
  return {
    status: response.status,
    body: (await response.json()) as ModelAnswer["body"],
    ms: performance.now() - started,
  };
}

/**
 * Run a check that must fail on a model problem, and fail with its message and how long it took
 * (`gave up after 123ms`): the test that runs the stand-ins holds it to the second exit check 13.4 allows.
 */
export async function timed(check: Promise<unknown>): Promise<void> {
  const started = performance.now();
  try {
    await check;
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\n(the matcher gave up after ${Math.round(performance.now() - started)}ms)`,
    );
  }
  throw new Error(`the matcher passed after ${Math.round(performance.now() - started)}ms`);
}
