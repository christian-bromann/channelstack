/**
 * A model on the official `openai` SDK, on Chat Completions, streaming: what the reference agent
 * on it answers with, and its broken variant too. The tools are run here, until the model answers
 * without calling one (at most five steps).
 */
import type OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

import { type Model, runTool, TOOLS } from "./model-agent.ts";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-5-mini";

const tools: ChatCompletionTool[] = Object.entries(TOOLS).map(([name, tool]) => ({
  type: "function",
  function: { name, description: tool.description, parameters: tool.parameters },
}));

/** The model, on this client. */
export const chatModel = (openai: OpenAI): Model => ({
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
});
