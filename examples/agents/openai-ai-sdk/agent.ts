/**
 * A reference agent: a Bolt app that answers through the AI SDK's OpenAI provider, on the
 * Responses API, streaming, with the AI SDK running the tools. It hands the model the files
 * people share (their bytes, downloaded with the bot token), posts the images OpenAI's image
 * tool makes, and asks a person before OpenAI runs a remote MCP server's tool. It has no
 * channelstack code in it: the provider takes `OPENAI_BASE_URL` and `OPENAI_API_KEY` from the
 * environment (`channelstack env` prints them).
 */
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, jsonSchema, type ModelMessage, stepCountIs, streamText, type Tool, tool } from "ai";

import { createApp, listen } from "../shared/bolt.ts";
import { type Model, modelAgent, runTool, type Streaming, TOOLS } from "../shared/model-agent.ts";

/**
 * A used-up quota (429 with `type: "insufficient_quota"`: a plan or spend limit) doesn't clear by
 * trying again, but the AI SDK retries every 429. This turns such an answer into the AI SDK's own
 * error, marked not retryable, so it gives up at once and the person hears so; every other answer
 * reaches the AI SDK as it came, and it retries what can clear.
 */
const quotaIsFinal = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const response = await fetch(input, init);
  if (response.status !== 429) return response;
  const responseBody = await response.clone().text();
  let data: { error?: { type?: string; message?: string } } | undefined;
  try {
    data = JSON.parse(responseBody) as typeof data;
  } catch {
    return response;
  }
  if (data?.error?.type !== "insufficient_quota") return response;
  throw new APICallError({
    message: data.error.message ?? "insufficient_quota",
    url: input instanceof Request ? input.url : String(input),
    requestBodyValues: undefined,
    statusCode: response.status,
    responseHeaders: Object.fromEntries(response.headers),
    responseBody,
    data,
    isRetryable: false,
  });
};

const { OPENAI_BASE_URL, OPENAI_API_KEY } = process.env;
const provider = createOpenAI({
  ...(OPENAI_BASE_URL === undefined ? {} : { baseURL: OPENAI_BASE_URL }),
  ...(OPENAI_API_KEY === undefined ? {} : { apiKey: OPENAI_API_KEY }),
  // The provider only calls it; the type is the global `fetch`'s, `preconnect` and all.
  fetch: quotaIsFinal as typeof fetch,
});
const MODEL = process.env.OPENAI_MODEL ?? "gpt-5-mini";

const tools = {
  ...Object.fromEntries(
    Object.entries(TOOLS).map(([name, definition]) => [
      name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema<Record<string, unknown>>(definition.parameters as never),
        execute: async (input) => runTool(name, input),
      }),
    ]),
  ),
  // OpenAI's own tools: it runs them, and the agent sees their results. The provider's types
  // come from a newer `@ai-sdk/provider-utils` than `ai`'s, the same at run time.
  image_generation: provider.tools.imageGeneration({ outputFormat: "png" }) as unknown as Tool,
  deploys: provider.tools.mcp({
    serverLabel: "deploys",
    serverUrl: process.env.DEPLOYS_MCP_URL ?? "https://mcp.deploys.example/sse",
    requireApproval: "always",
  }) as unknown as Tool,
};

/** One step of the conversation: stream the answer, post what OpenAI's tools made, and ask before an MCP tool runs. */
async function run(system: string, messages: ModelMessage[], user: string, streaming: Streaming): Promise<void> {
  const result = streamText({
    model: provider.responses(MODEL),
    system,
    messages,
    tools,
    stopWhen: stepCountIs(5),
    abortSignal: streaming.signal,
    providerOptions: { openai: { user } },
    // The AI SDK retries on its own; the official SDK's retries are the other agent's.
    maxRetries: 2,
  });
  const asked: { approvalId: string; tool: string; input: unknown }[] = [];
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") await streaming.onText(part.text);
    if (part.type === "tool-result" && part.toolName === "image_generation") {
      const { result: image } = part.output as { result: string };
      await streaming.onImage?.(Buffer.from(image, "base64"), "image.png");
    }
    if (part.type === "tool-approval-request") {
      asked.push({
        approvalId: part.approvalId,
        tool: part.toolCall.toolName.replace(/^mcp\./, ""),
        input: part.toolCall.input,
      });
    }
    if (part.type === "error") throw part.error;
  }
  if (asked.length === 0 || streaming.onApproval === undefined) return;
  const { messages: answered } = await result.response;
  for (const { approvalId, tool: name, input } of asked) {
    await streaming.onApproval({
      tool: name,
      arguments: input,
      // The conversation goes on from the answer that asked, with the person's decision.
      resume: (approved, next) =>
        run(
          system,
          [
            ...messages,
            ...answered,
            // OpenAI runs the tool, so the AI SDK forwards the decision to it.
            {
              role: "tool",
              content: [{ type: "tool-approval-response", approvalId, approved, providerExecuted: true }],
            },
          ],
          user,
          next,
        ),
    });
  }
}

const model: Model = {
  answer({ instructions, history, user, ...streaming }) {
    const messages = history.map((turn): ModelMessage =>
      turn.role === "assistant" || turn.files === undefined
        ? { role: turn.role, content: turn.text }
        : {
            role: "user",
            content: [
              { type: "text", text: turn.text },
              ...turn.files.map((file) => ({
                type: "file" as const,
                data: file.bytes,
                mediaType: file.mediaType,
                filename: file.name,
              })),
            ],
          },
    );
    return run(instructions, messages, user, streaming);
  },
};

const app = createApp();
modelAgent(app, model);
await listen(app);
