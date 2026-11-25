import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "vitest";

import { ROOT } from "../../scripts/lib/generate.ts";
import { binaryPath } from "../../scripts/lib/packages.ts";
import { withStack } from "../../scripts/lib/stack.ts";
import { waitFor } from "../../sdks/typescript/runtime/wait.ts";

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("");

// Exit check 7.4: a coding agent drives a conversation through `channelstack mcp`. A scripted MCP
// client lists the tools, posts as a person who doesn't exist yet, and reads the agent's reply.
test("an MCP client posts as a person and reads the agent's reply", async () => {
  const bin = process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();
  await withStack(
    {
      bin,
      agent: join(ROOT, "examples", "agents", "bolt-ai-sdk", "agent.ts"),
      webhook: { driver: "slack", path: "/slack/events" },
    },
    async ({ env, home }) => {
      const transport = new StdioClientTransport({
        command: bin,
        args: ["mcp"],
        env: Object.fromEntries(
          Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        stderr: "pipe",
      });
      const client = new Client({ name: "channelstack-test", version: "0.0.0" });
      await client.connect(transport);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([
          "list_deliveries",
          "redeliver",
          "show_thread",
          "slack_click",
          "slack_react",
          "slack_reply",
          "slack_say",
          "slack_stop",
          "tail",
        ]);

        // Ana doesn't exist yet: the first message creates her, and #support with her and the bot in it.
        const said = await client.callTool({
          name: "slack_say",
          arguments: { as: "ana", channel: "#support", text: "@my-agent hi" },
        });
        expect(said.isError).toBeFalsy();
        expect(text(said)).toMatch(/^ana said it in #support/);

        const reply = 'my-agent: Here\'s what I found about "hi".';
        const shown = await waitFor("the agent's reply in show_thread", async () => {
          const result = text(await client.callTool({ name: "show_thread", arguments: {} }));
          return result.includes(reply) ? result : undefined;
        });
        expect(shown).toBe(`ana: @my-agent hi\n  ${reply}\n`);

        // What went to the bot and what it called, and the delivery to send again.
        const tail = text(await client.callTool({ name: "tail", arguments: {} }));
        expect(tail).toMatch(/→ slack app_mention {2}200/);
        expect(tail).toMatch(/← slack chat\.postMessage {2}200/);
        const deliveries = text(await client.callTool({ name: "list_deliveries", arguments: { channel: "slack" } }));
        const [delivery] = deliveries.split(" ");
        expect(deliveries).toMatch(/^Ev\w+ {2}event_callback app_mention {2}acknowledged {2}\(attempts: 200\)$/m);
        const again = await client.callTool({ name: "redeliver", arguments: { channel: "slack", delivery } });
        expect(text(again)).toBe(`Retried ${delivery} (slack)\n`);
        // The bot got it a second time: the delivery has a second attempt.
        await waitFor("the delivery's second attempt", async () => {
          const listed = text(await client.callTool({ name: "list_deliveries", arguments: { channel: "slack" } }));
          return (
            listed.includes(`${delivery}  event_callback app_mention  acknowledged  (attempts: 200, 200)`) || undefined
          );
        });

        // A mistake is the tool's error, in a sentence, and the token never shows.
        const mistake = await client.callTool({ name: "redeliver", arguments: { channel: "slack", delivery: "nope" } });
        expect(mistake.isError).toBe(true);
        // A mistake keeps the attachment: `tail` goes on from where it was, with the retry and nothing before it.
        const next = text(await client.callTool({ name: "tail", arguments: {} }));
        expect(next).toMatch(/^\S+ → slack app_mention \(attempt 2\) {2}200\n$/);
        const { token } = JSON.parse(readFileSync(join(home, "server.json"), "utf8")) as { token: string };
        expect(token.length).toBeGreaterThan(16);
        for (const output of [said, shown, tail, deliveries, mistake, next]) {
          expect(typeof output === "string" ? output : text(output)).not.toContain(token);
        }
      } finally {
        await client.close();
      }
    },
  );
});
