/**
 * OpenAI's built-in tools, scripted and never run (exit check 14.4), against the official
 * `openai` SDK in process. Per tool: its items and events, whole and streamed, held to the pinned
 * description; a tool the request didn't offer is a script problem; the MCP approval round trip;
 * a client-run tool's output joined in `toolCalls()`. And a code interpreter's container files.
 */
import type { APIError } from "openai";
import { describe, expect, test } from "vitest";

import { useOpenAIWorkspace } from "../../../../test/openai-workspace.ts";
import { placeholderPng } from "../media.ts";

const setup = useOpenAIWorkspace();

type Item = Record<string, any>;
/** The SDK's types lag the API's newest tools; the fake is held to the description instead. */
type Body = Record<string, unknown>;

/** A Responses call as an agent makes it, and its output items. */
async function ask(
  client: Awaited<ReturnType<typeof setup>>["client"],
  body: Body,
): Promise<{ id: string; output: Item[] }> {
  const response = (await client.responses.create({ model: "gpt-5", ...body } as never)) as unknown as {
    id: string;
    output: Item[];
  };
  return response;
}

/** The same, streamed: the event types in order, and the response it completes with. */
async function streamed(client: Awaited<ReturnType<typeof setup>>["client"], body: Body) {
  const stream = (await client.responses.create({
    model: "gpt-5",
    ...body,
    stream: true,
  } as never)) as unknown as AsyncIterable<Item>;
  const events: Item[] = [];
  for await (const event of stream) events.push(event);
  return { types: events.map((event) => event.type as string), events, response: events.at(-1)?.response as Item };
}

describe("hosted tools: OpenAI runs them, the script says what they found", () => {
  test("web_search: the call with its sources, then the text with its citations", async () => {
    const { client, respond, prompt } = await setup();
    const turn = {
      toolCalls: [{ webSearch: { query: "web deploy outage", sources: [{ url: "https://status.example/123" }] } }],
      text: "The status page says the deploy failed.",
      citations: [{ quote: "the deploy failed", url: "https://status.example/123", title: "Status" }],
    };
    await respond({ turns: [turn, turn] });
    const body = { input: prompt, tools: [{ type: "web_search" }], include: ["web_search_call.action.sources"] };

    const { output } = await ask(client, body);
    const { types } = await streamed(client, body);

    expect(output.map((item) => item.type)).toEqual(["web_search_call", "message"]);
    expect(output[0]?.action).toEqual({
      type: "search",
      query: "web deploy outage",
      queries: ["web deploy outage"],
      sources: [{ type: "url", url: "https://status.example/123" }],
    });
    expect(output[1]?.content[0].annotations).toEqual([
      { type: "url_citation", start_index: 21, end_index: 38, url: "https://status.example/123", title: "Status" },
    ]);
    expect(types).toEqual(
      expect.arrayContaining([
        "response.web_search_call.in_progress",
        "response.web_search_call.searching",
        "response.web_search_call.completed",
        "response.output_text.annotation.added",
      ]),
    );
    expect(types.indexOf("response.web_search_call.completed")).toBeLessThan(
      types.indexOf("response.output_text.delta"),
    );
  });

  test("file_search: its queries, its results when asked, and file citations", async () => {
    const { client, respond, prompt } = await setup();
    await respond({
      turns: [
        {
          toolCalls: [
            {
              fileSearch: { queries: ["deploy runbook"], results: [{ file: "runbook.md", text: "Roll back first." }] },
            },
          ],
          text: "The runbook says to roll back first.",
          citations: [{ quote: "roll back first", file: "runbook.md" }],
        },
      ],
    });

    const { output } = await ask(client, {
      input: prompt,
      tools: [{ type: "file_search", vector_store_ids: ["vs_123"] }],
      include: ["file_search_call.results"],
    });

    expect(output[0]).toEqual(
      expect.objectContaining({ type: "file_search_call", queries: ["deploy runbook"], status: "completed" }),
    );
    expect(output[0]?.results).toEqual([
      expect.objectContaining({
        filename: "runbook.md",
        text: "Roll back first.",
        file_id: expect.stringMatching(/^file-/),
      }),
    ]);
    expect(output[1]?.content[0].annotations).toEqual([
      expect.objectContaining({ type: "file_citation", filename: "runbook.md", index: 35 }),
    ]);
  });

  test("code_interpreter: code, logs and an image, and the file it wrote downloadable from its container", async () => {
    const { client, respond, prompt } = await setup();
    const chart = placeholderPng(10, 10);
    const turn = {
      toolCalls: [
        {
          codeInterpreter: {
            code: "plot(deploys)",
            logs: "5 deploys",
            files: [{ content: Buffer.from(chart).toString("base64"), name: "chart.png" }],
          },
        },
      ],
      text: "Here is chart.png.",
      citations: [{ quote: "chart.png", file: "chart.png" }],
    };
    await respond({ turns: [turn, turn] });
    const body = {
      input: prompt,
      tools: [{ type: "code_interpreter", container: { type: "auto" } }],
      include: ["code_interpreter_call.outputs"],
    };

    const { output } = await ask(client, body);
    const { types } = await streamed(client, body);

    const [call, message] = output;
    expect(call).toEqual(expect.objectContaining({ type: "code_interpreter_call", code: "plot(deploys)" }));
    expect(call?.outputs).toEqual([
      { type: "logs", logs: "5 deploys" },
      { type: "image", url: expect.stringMatching(/^data:image\/png;base64,/) },
    ]);
    const [citation] = message?.content[0].annotations ?? [];
    expect(citation).toEqual(
      expect.objectContaining({
        type: "container_file_citation",
        container_id: call?.container_id,
        filename: "chart.png",
      }),
    );
    const content = await client.containers.files.content.retrieve(citation.file_id, {
      container_id: citation.container_id,
    });
    expect(Buffer.from(await content.arrayBuffer())).toEqual(Buffer.from(chart));
    const listed = await client.containers.files.list(citation.container_id);
    expect(listed.data.map((file) => file.path)).toEqual(["/mnt/data/chart.png"]);
    expect(types).toEqual(
      expect.arrayContaining([
        "response.code_interpreter_call_code.delta",
        "response.code_interpreter_call_code.done",
        "response.code_interpreter_call.interpreting",
        "response.code_interpreter_call.completed",
      ]),
    );
  });

  test("a turn the fake refuses leaves no files in the container", async () => {
    const { client, respond, prompt } = await setup();
    const container = `cntr_${"a".repeat(48)}`;
    await respond({
      turns: [
        {
          toolCalls: [{ codeInterpreter: { code: "plot()", files: [{ placeholder: {} }] } }],
          text: "Done.",
          citations: [{ quote: "not in the text", url: "https://x.example" }],
        },
      ],
    });

    const refused = await ask(client, {
      input: prompt,
      tools: [{ type: "code_interpreter", container }],
    }).catch((caught: unknown) => caught);
    const files = await client.containers.files.list(container).catch((caught: unknown) => caught);

    expect((refused as APIError).code).toBe("channelstack_no_script");
    expect((files as APIError).status).toBe(404);
  });

  test("image_generation: the base64 image, with partial images when asked", async () => {
    const { client, respond, prompt } = await setup();
    await respond({
      turns: [
        {
          toolCalls: [
            { imageGeneration: { image: { placeholder: { width: 16, height: 16 } }, revisedPrompt: "A chart." } },
          ],
        },
      ],
    });

    const { events, response } = await streamed(client, {
      input: prompt,
      tools: [{ type: "image_generation", partial_images: 2 }],
    });

    const call = response.output[0];
    expect(call).toEqual(
      expect.objectContaining({ type: "image_generation_call", output_format: "png", revised_prompt: "A chart." }),
    );
    expect(Buffer.from(call.result, "base64").subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(events.filter((event) => event.type === "response.image_generation_call.partial_image")).toHaveLength(2);
  });

  test("hosted shell: the call and its output, as the script says", async () => {
    const { client, respond, prompt, control } = await setup();
    const turn = { toolCalls: [{ shell: { commands: ["ls"], output: "deploy.log\n" } }], text: "One log." };
    await respond({ turns: [turn, turn] });
    const body = { input: prompt, tools: [{ type: "shell", environment: { type: "container_auto" } }] };

    const { output } = await ask(client, body);
    const { types } = await streamed(client, body);

    expect(output.map((item) => item.type)).toEqual(["shell_call", "shell_call_output", "message"]);
    expect(output[1]?.output).toEqual([
      { stdout: "deploy.log\n", stderr: "", outcome: { type: "exit", exit_code: 0 } },
    ]);
    expect(types).toEqual(
      expect.arrayContaining(["response.shell_call_command.delta", "response.shell_call_output_content.done"]),
    );
    expect((await control("GET", "/tool-calls"))[0]).toEqual(
      expect.objectContaining({
        type: "shell",
        hosted: true,
        result: expect.objectContaining({ text: "deploy.log\n" }),
      }),
    );
  });
});

describe("remote MCP: approval, then the call", () => {
  const mcpTool = {
    type: "mcp",
    server_label: "deploys",
    server_url: "https://mcp.example/sse",
    require_approval: "always",
  };
  const deploy = { server: "deploys", tool: "deploy", arguments: { app: "web" } };

  test("an approval request, the agent's approval, then the call that names it", async () => {
    const { client, respond, prompt, control } = await setup();
    const script = await respond({
      turns: [
        { toolCalls: [{ mcp: { ...deploy, approval: true } }] },
        { toolCalls: [{ mcp: { ...deploy, output: "started" } }], text: "Deploying web." },
      ],
    });

    const first = await ask(client, { input: prompt, tools: [mcpTool] });
    expect(first.output.map((item) => item.type)).toEqual(["mcp_list_tools", "mcp_approval_request"]);
    const request = first.output[1] as Item;
    expect(request).toEqual(
      expect.objectContaining({ server_label: "deploys", name: "deploy", arguments: '{"app":"web"}' }),
    );

    const { response, types } = await streamed(client, {
      previous_response_id: first.id,
      input: [{ type: "mcp_approval_response", approval_request_id: request.id, approve: true }],
      tools: [mcpTool],
    });

    // The tools were listed in the conversation already, so only the call comes.
    expect(response.output.map((item: Item) => item.type)).toEqual(["mcp_call", "message"]);
    expect(response.output[0]).toEqual(
      expect.objectContaining({
        name: "deploy",
        output: "started",
        approval_request_id: request.id,
        status: "completed",
      }),
    );
    expect(types).toEqual(expect.arrayContaining(["response.mcp_call_arguments.delta", "response.mcp_call.completed"]));
    const calls = await control("GET", `/scripts/${script.id}/tool-calls`);
    expect(calls).toEqual([
      expect.objectContaining({
        type: "mcp",
        name: "deploy",
        id: request.id,
        result: expect.objectContaining({ text: "approved" }),
      }),
      expect.objectContaining({ type: "mcp", name: "deploy", result: expect.objectContaining({ text: "started" }) }),
    ]);
  });

  test("a call after the agent declined is a script problem", async () => {
    const { client, respond, prompt, control } = await setup();
    await respond({
      turns: [
        { toolCalls: [{ mcp: { ...deploy, approval: true } }] },
        { toolCalls: [{ mcp: { ...deploy, output: "started" } }] },
      ],
    });
    const first = await ask(client, { input: prompt, tools: [mcpTool] });
    const request = first.output[1] as Item;

    const error = await ask(client, {
      previous_response_id: first.id,
      input: [{ type: "mcp_approval_response", approval_request_id: request.id, approve: false }],
      tools: [mcpTool],
    }).catch((caught: unknown) => caught);

    expect((error as APIError).code).toBe("channelstack_no_script");
    expect(await control("GET", "/problems")).toContainEqual(expect.stringMatching(/declined its approval request/));
  });

  test("a call without approval, when the request requires it, is a script problem", async () => {
    const { client, respond, prompt, control } = await setup();
    await respond({ turns: [{ toolCalls: [{ mcp: { ...deploy, output: "started" } }] }] });

    const error = await ask(client, { input: prompt, tools: [mcpTool] }).catch((caught: unknown) => caught);

    expect((error as APIError).code).toBe("channelstack_no_script");
    expect(await control("GET", "/problems")).toContainEqual(expect.stringMatching(/without approval/));
  });

  test("a server the request doesn't name is a script problem", async () => {
    const { client, respond, prompt, control } = await setup();
    await respond({ turns: [{ toolCalls: [{ mcp: { ...deploy, server: "billing", approval: true } }] }] });

    await ask(client, { input: prompt, tools: [mcpTool] }).catch(() => undefined);

    expect(await control("GET", "/problems")).toContainEqual(expect.stringMatching(/the MCP server `billing`/));
  });

  test("a tool the request's allowed_tools leaves out is a script problem", async () => {
    const { client, respond, prompt, control } = await setup();
    await respond({ turns: [{ toolCalls: [{ mcp: { ...deploy, approval: true } }] }] });

    await ask(client, { input: prompt, tools: [{ ...mcpTool, allowed_tools: ["status"] }] }).catch(() => undefined);

    expect(await control("GET", "/problems")).toContainEqual(
      expect.stringMatching(/called `deploy` on the MCP server `deploys`, but the request allows only `status`/),
    );
  });

  test("an approval counts for the call right after it: a later call needs a new one", async () => {
    const { client, respond, prompt, control } = await setup();
    await respond({
      turns: [
        { toolCalls: [{ mcp: { ...deploy, approval: true } }] },
        { toolCalls: [{ mcp: { ...deploy, output: "started" } }], text: "Deploying." },
        { toolCalls: [{ mcp: { ...deploy, output: "started again" } }] },
      ],
    });
    const first = await ask(client, { input: prompt, tools: [mcpTool] });
    const request = first.output[1] as Item;
    const second = await ask(client, {
      previous_response_id: first.id,
      input: [{ type: "mcp_approval_response", approval_request_id: request.id, approve: true }],
      tools: [mcpTool],
    });

    const third = await ask(client, {
      previous_response_id: second.id,
      input: [{ role: "user", content: "and again" }],
      tools: [mcpTool],
    }).catch((caught: unknown) => caught);

    expect((third as APIError).code).toBe("channelstack_no_script");
    expect(await control("GET", "/problems")).toContainEqual(expect.stringMatching(/without approval/));
  });

  test("resent whole instead of chained, an approval a call already used doesn't count again", async () => {
    const { client, respond, prompt, control } = await setup();
    await respond({
      turns: [
        { toolCalls: [{ mcp: { ...deploy, approval: true } }] },
        { toolCalls: [{ mcp: { ...deploy, output: "started" } }], text: "Deploying." },
        { toolCalls: [{ mcp: { ...deploy, output: "started again" } }] },
      ],
    });
    const user = { role: "user", content: prompt };
    const first = await ask(client, { store: false, input: [user], tools: [mcpTool] });
    const approval = {
      type: "mcp_approval_response",
      approval_request_id: (first.output[1] as Item).id,
      approve: true,
    };
    const second = await ask(client, { store: false, input: [user, ...first.output, approval], tools: [mcpTool] });

    const third = await ask(client, {
      store: false,
      input: [user, ...first.output, approval, ...second.output, { role: "user", content: "deploy again" }],
      tools: [mcpTool],
    }).catch((caught: unknown) => caught);

    expect(second.output[0]).toEqual(
      expect.objectContaining({ type: "mcp_call", approval_request_id: approval.approval_request_id }),
    );
    expect((third as APIError).code).toBe("channelstack_no_script");
    expect(await control("GET", "/problems")).toContainEqual(expect.stringMatching(/without approval/));
  });

  test("a decline earlier in the conversation doesn't block a call approved now", async () => {
    const { client, respond, prompt } = await setup();
    await respond({
      turns: [
        { toolCalls: [{ mcp: { ...deploy, approval: true } }] },
        { toolCalls: [{ mcp: { ...deploy, approval: true } }], text: "Asking again." },
        { toolCalls: [{ mcp: { ...deploy, output: "started" } }] },
      ],
    });
    const first = await ask(client, { input: prompt, tools: [mcpTool] });
    const declined = first.output[1] as Item;
    const second = await ask(client, {
      previous_response_id: first.id,
      input: [{ type: "mcp_approval_response", approval_request_id: declined.id, approve: false }],
      tools: [mcpTool],
    });
    const asked = second.output.find((item) => item.type === "mcp_approval_request") as Item;

    const third = await ask(client, {
      previous_response_id: second.id,
      input: [{ type: "mcp_approval_response", approval_request_id: asked.id, approve: true }],
      tools: [mcpTool],
    });

    expect(third.output[0]).toEqual(expect.objectContaining({ type: "mcp_call", approval_request_id: asked.id }));
  });

  test("`when: { approval }` matches the call that carries the approval, and no later one", async () => {
    const { client, respond, prompt, control } = await setup();
    await respond({ turns: [{ toolCalls: [{ mcp: { ...deploy, approval: true } }] }] });
    const approved = await respond({
      turns: [{ toolCalls: [{ mcp: { ...deploy, output: "started" } }] }],
      when: { approval: true },
      // It could answer every call: only `when` keeps it from the later one.
      times: -1,
    });
    await respond({ turns: ["Done."] });
    const first = await ask(client, { input: prompt, tools: [mcpTool] });
    const second = await ask(client, {
      previous_response_id: first.id,
      input: [{ type: "mcp_approval_response", approval_request_id: (first.output[1] as Item).id, approve: true }],
      tools: [mcpTool],
    });

    await ask(client, {
      previous_response_id: second.id,
      input: [{ role: "user", content: "thanks" }],
      tools: [mcpTool],
    });

    expect((await control("GET", `/scripts/${approved.id}`)).used).toBe(1);
  });
});

describe("client-run tools: the agent runs them, and its output is joined", () => {
  test.each([
    {
      name: "shell, local",
      tool: { type: "shell", environment: { type: "local" } },
      call: { shell: { commands: ["git status"] } },
      item: "shell_call",
      output: (call_id: string) => ({
        type: "shell_call_output",
        call_id,
        output: [{ stdout: "clean", stderr: "", outcome: { type: "exit", exit_code: 0 } }],
      }),
      result: "clean",
    },
    {
      name: "local_shell",
      tool: { type: "local_shell" },
      call: { shell: { commands: ["git status"] } },
      item: "local_shell_call",
      output: (call_id: string) => ({ type: "local_shell_call_output", call_id, output: "clean" }),
      result: "clean",
    },
    {
      name: "computer",
      tool: { type: "computer" },
      call: { computer: { actions: [{ type: "click", button: "left", x: 10, y: 20 }, { type: "screenshot" }] } },
      item: "computer_call",
      output: (call_id: string) => ({
        type: "computer_call_output",
        call_id,
        output: { type: "computer_screenshot", image_url: "https://shots.example/1.png" },
      }),
      result: "https://shots.example/1.png",
    },
    {
      name: "apply_patch",
      tool: { type: "apply_patch" },
      call: { applyPatch: { operations: [{ type: "update_file", path: "deploy.yml", diff: "@@\n-a\n+b\n" }] } },
      item: "apply_patch_call",
      output: (call_id: string) => ({
        type: "apply_patch_call_output",
        call_id,
        status: "completed",
        output: "patched",
      }),
      result: "patched",
    },
  ])("$name", async ({ tool, call, item, output, result }) => {
    const { client, respond, prompt, control } = await setup();
    await respond({ turns: [{ toolCalls: [call] }, { toolCalls: [call] }, "Done."] });

    const first = await ask(client, { input: prompt, tools: [tool] });
    await streamed(client, { input: prompt, tools: [tool] });
    const made = first.output[0] as Item;
    expect(made.type).toBe(item);
    await ask(client, { previous_response_id: first.id, input: [output(made.call_id)], tools: [tool] });

    const [joined] = await control("GET", "/tool-calls");
    expect(joined).toEqual(
      expect.objectContaining({ hosted: false, id: made.call_id, result: expect.objectContaining({ text: result }) }),
    );
  });

  test("apply_patch: one call per file operation", async () => {
    const { client, respond, prompt } = await setup();
    await respond({
      turns: [
        {
          toolCalls: [
            {
              applyPatch: {
                operations: [
                  { type: "create_file", path: "a.md", diff: "+a\n" },
                  { type: "delete_file", path: "b.md" },
                ],
              },
            },
          ],
        },
      ],
    });

    const { output } = await ask(client, { input: prompt, tools: [{ type: "apply_patch" }] });

    expect(output.map((item) => item.operation)).toEqual([
      { type: "create_file", path: "a.md", diff: "+a\n" },
      { type: "delete_file", path: "b.md" },
    ]);
  });

  test("a local shell's output in the script is a script problem: the agent sends it", async () => {
    const { client, respond, prompt, control } = await setup();
    await respond({ turns: [{ toolCalls: [{ shell: { commands: ["ls"], output: "x" } }] }] });

    await ask(client, { input: prompt, tools: [{ type: "local_shell" }] }).catch(() => undefined);

    expect(await control("GET", "/problems")).toContainEqual(expect.stringMatching(/the agent sends the output/));
  });
});

describe("what the real API couldn't do", () => {
  test("a built-in tool the request didn't offer is a script problem", async () => {
    const { client, respond, prompt, control } = await setup();
    await respond({ turns: [{ toolCalls: [{ webSearch: { query: "deploys" } }] }] });

    const error = await ask(client, { input: prompt }).catch((caught: unknown) => caught);

    expect((error as APIError).code).toBe("channelstack_no_script");
    expect(await control("GET", "/problems")).toContainEqual(
      expect.stringMatching(/called `web_search`, but the request offered no tools/),
    );
  });

  test("Chat Completions has no built-in tools: offering one is refused, scripting one is a problem", async () => {
    const { client, respond, prompt, control } = await setup();
    await respond({ turns: [{ toolCalls: [{ webSearch: { query: "deploys" } }] }] });

    const refused = await client.chat.completions
      .create({
        model: "gpt-5",
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search" }] as never,
      })
      .catch((caught: unknown) => caught);
    const problem = await client.chat.completions
      .create({ model: "gpt-5", messages: [{ role: "user", content: prompt }] })
      .catch((caught: unknown) => caught);

    expect((refused as APIError).code).toBe("invalid_value");
    expect((problem as APIError).code).toBe("channelstack_no_script");
    expect(await control("GET", "/problems")).toContainEqual(expect.stringMatching(/only the Responses API has/));
  });

  test("a citation of text the answer doesn't have is a problem", async () => {
    const { client, respond, prompt, control } = await setup();
    await respond({
      turns: [
        {
          toolCalls: [{ webSearch: { query: "x" } }],
          text: "Fine.",
          citations: [{ quote: "broken", url: "https://x.example" }],
        },
      ],
    });

    await ask(client, { input: prompt, tools: [{ type: "web_search" }] }).catch(() => undefined);

    expect(await control("GET", "/problems")).toContainEqual(
      expect.stringMatching(/cites "broken", which isn't in its text/),
    );
  });
});
