/**
 * A reference agent: a Bolt app that answers through the official `openai` SDK, on Chat
 * Completions, streaming. It has no channelstack code in it: the SDK reads `OPENAI_BASE_URL` and
 * `OPENAI_API_KEY` by itself (`channelstack env` prints them), so in tests it talks to the fake
 * OpenAI, and to OpenAI itself when they are unset.
 */
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

import { createApp, listen } from "../shared/bolt.ts";
import { type Model, modelAgent, runTool, TOOLS } from "../shared/model-agent.ts";

const openai = new OpenAI();
const MODEL = process.env.OPENAI_MODEL ?? "gpt-5-mini";

const tools: ChatCompletionTool[] = Object.entries(TOOLS).map(([name, tool]) => ({
  type: "function",
  function: { name, description: tool.description, parameters: tool.parameters },
}));

const model: Model = {
  async answer({ instructions, history, user, signal, onText }) {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: instructions },
      ...history.map((turn) => ({ role: turn.role, content: turn.text })),
    ];
    // Until the model answers without a tool call: at most five steps.
    for (let step = 0; step < 5; step += 1) {
      const stream = await openai.chat.completions.create(
        { model: MODEL, messages, tools, stream: true, user },
        { signal },
      );
      const calls: Array<{ id: string; name: string; arguments: string }> = [];
      let text = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          text += delta.content;
          await onText(delta.content);
        }
        for (const part of delta?.tool_calls ?? []) {
          const call = calls[part.index] ?? { id: "", name: "", arguments: "" };
          calls[part.index] = call;
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name = part.function.name;
          call.arguments += part.function?.arguments ?? "";
        }
      }
      if (calls.length === 0) return;
      messages.push({
        role: "assistant",
        content: text === "" ? null : text,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      for (const call of calls) {
        let args: unknown;
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {
          args = {};
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: runTool(call.name, args) });
      }
    }
  },
};

const app = createApp();
modelAgent(app, model);
await listen(app);
