/** `channelstack openai respond|calls|undo` in the dev session, against the app in memory. */
import OpenAI from "openai";
import { describe, expect, test } from "vitest";

import { harness } from "../../test/app-harness.ts";
import { type Attached, CliError } from "./attach.ts";
import { runOpenAI } from "./openai.ts";

/** The CLI's view of a server: the app in memory, and its dev session. */
function attached() {
  const h = harness();
  const server: Attached = {
    url: "http://127.0.0.1:4500",
    async request<T>(method: string, path: string, body?: unknown) {
      const response = await h.call(method, path, body);
      if (response.status >= 400) throw new CliError(response.body.message);
      return response.body as T;
    },
    devSession: async () => (await h.call("POST", "/sessions", { name: "dev" })).body.sessionId,
  };
  const client = new OpenAI({
    apiKey: h.secrets.get("openai", "apiKey"),
    baseURL: "http://127.0.0.1:4500/openai/v1",
    fetch: (input, init) => Promise.resolve(h.app.fetch(new Request(input as string, init as RequestInit))),
  });
  return { server, client };
}

describe("channelstack openai", () => {
  test("respond scripts the dev session's model, calls lists what it answered, undo removes the script", async () => {
    const { server, client } = attached();
    const session = await server.devSession();

    const scripted = await runOpenAI(server, "respond", ["You", "asked:", "{lastUserText}"], { times: "-1" });
    expect(scripted).toMatch(/^ms_\w+: the model answers every matching call\n$/);
    const answer = await client.chat.completions.create({
      model: "gpt-5",
      user: session,
      messages: [{ role: "user", content: "what broke?" }],
    });
    expect(answer.choices[0]?.message.content).toBe("You asked: what broke?");

    expect(await runOpenAI(server, "calls", [], {})).toMatch(
      /chat\.completions gpt-5 "what broke\?" → 200 "You asked: what broke\?" \(ms_\w+\)/,
    );
    const id = scripted.split(":")[0] ?? "";
    expect(await runOpenAI(server, "undo", [id], {})).toBe(`Removed ${id}.\n`);
  });

  test("a tool call first, then the answer; and what's wrong is said in a sentence", async () => {
    const { server } = attached();

    expect(
      await runOpenAI(server, "respond", ["Done."], { tool: "search", args: '{"q":"x"}', when: "deploy" }),
    ).toMatch(/answers 2 calls about "deploy"/);
    await expect(runOpenAI(server, "respond", [], { tool: "search", args: "{nope" })).rejects.toThrow(
      /--args is the tool's arguments as JSON/,
    );
    await expect(runOpenAI(server, "respond", [], {})).rejects.toThrow(/say what the model answers/);
    await expect(runOpenAI(server, "nope", [], {})).rejects.toThrow(/respond, calls or undo/);
    expect(await runOpenAI(server, "calls", [], {})).toBe("No model calls yet.\n");
  });
});
