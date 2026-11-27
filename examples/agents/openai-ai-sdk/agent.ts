/**
 * A reference agent: a Bolt app that answers through the AI SDK's OpenAI provider, on the
 * Responses API, streaming, with the AI SDK running the tools. It has no channelstack code in it:
 * the provider takes `OPENAI_BASE_URL` and `OPENAI_API_KEY` from the environment (`channelstack
 * env` prints them).
 */
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";

import { createApp, listen } from "../shared/bolt.ts";
import { type Model, modelAgent, runTool, TOOLS } from "../shared/model-agent.ts";

const { OPENAI_BASE_URL, OPENAI_API_KEY } = process.env;
const provider = createOpenAI({
  ...(OPENAI_BASE_URL === undefined ? {} : { baseURL: OPENAI_BASE_URL }),
  ...(OPENAI_API_KEY === undefined ? {} : { apiKey: OPENAI_API_KEY }),
});
const MODEL = process.env.OPENAI_MODEL ?? "gpt-5-mini";

const tools = Object.fromEntries(
  Object.entries(TOOLS).map(([name, definition]) => [
    name,
    tool({
      description: definition.description,
      inputSchema: jsonSchema<Record<string, unknown>>(definition.parameters as never),
      execute: async (input) => runTool(name, input),
    }),
  ]),
);

const model: Model = {
  async answer({ instructions, history, user, signal, onText }) {
    const result = streamText({
      model: provider.responses(MODEL),
      system: instructions,
      messages: history.map((turn) => ({ role: turn.role, content: turn.text })),
      tools,
      stopWhen: stepCountIs(5),
      abortSignal: signal,
      providerOptions: { openai: { user } },
      // The AI SDK retries on its own; the official SDK's retries are the other agent's.
      maxRetries: 2,
    });
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") await onText(part.text);
      if (part.type === "error") throw part.error;
    }
  },
};

const app = createApp();
modelAgent(app, model);
await listen(app);
