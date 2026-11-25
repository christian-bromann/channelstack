import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { attach, type Attached, type AttachFlags, CliError, ServerGoneError } from "./attach.ts";
import { DELIVERY_CHANNELS, runDeliveries, runRedeliver } from "./deliveries.ts";
import { runSlack } from "./slack.ts";
import { readEvents, runShow } from "./watch.ts";

/** A message as the tools name it: the newest one, or `<channel id>:<ts>` as `show_thread` prints them. */
const reference = z
  .string()
  .regex(/^(last|[A-Z0-9]+:\d+\.\d+)$/)
  .optional()
  .describe('"last" (the default: the newest message) or "<channel id>:<ts>"');
const person = z.string().min(1).describe("Who acts, by name, e.g. ana. Created the first time the name is used");

type Text = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * `channelstack mcp`: the attach CLI's commands as MCP tools, over stdio, for a coding agent that
 * is building the bot. They act in the same long-lived `dev` session as the CLI and the UI, so the
 * agent can post as a person, read what the bot answered, redeliver, and look again.
 *
 * It attaches on the first tool call, so it can start before the server does. Nothing it returns
 * carries the server's token: the tools print what `channelstack show`, `tail` and `deliveries` print.
 */
function mcpServer(flags: AttachFlags, version: string): McpServer {
  let attached: Attached | undefined;
  const server = () => {
    attached ??= attach(flags);
    return attached;
  };
  /** Run a command; a refusal or a mistake comes back as the tool's error, in a sentence. */
  const tool = async (run: (attached: Attached) => Promise<string>): Promise<Text> => {
    try {
      return { content: [{ type: "text", text: await run(server()) }] };
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      // A server that is gone (or restarted) may be back next time: attach again then. A mistake
      // in the call keeps the attachment, and with it where `tail` got to.
      if (error instanceof ServerGoneError) attached = undefined;
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
  };

  const mcp = new McpServer({ name: "channelstack", version });

  mcp.registerTool(
    "slack_say",
    {
      description: "Post a message in a Slack channel as a person, e.g. to mention the bot.",
      inputSchema: {
        as: person,
        channel: z.string().min(1).describe('The channel, e.g. "#support". Created with the person and the bot in it'),
        text: z.string().min(1).describe('What they say, e.g. "@my-agent summarize today"'),
      },
    },
    ({ as, channel, text }) => tool((attached) => runSlack(attached, "say", [text], { as, in: channel })),
  );
  mcp.registerTool(
    "slack_reply",
    {
      description: "Reply in a Slack thread as a person.",
      inputSchema: { as: person, text: z.string().min(1), thread: reference },
    },
    ({ as, text, thread }) => tool((attached) => runSlack(attached, "reply", [text], { as, thread })),
  );
  mcp.registerTool(
    "slack_react",
    {
      description: "React to a Slack message with an emoji, as a person.",
      inputSchema: { as: person, emoji: z.string().min(1).describe('e.g. ":eyes:"'), on: reference },
    },
    ({ as, emoji, on }) => tool((attached) => runSlack(attached, "react", [emoji], { as, on })),
  );
  mcp.registerTool(
    "slack_click",
    {
      description: "Click a button, as a person: the one with this label in the latest message that has it.",
      inputSchema: { as: person, label: z.string().min(1).describe('The button\'s label, e.g. "Approve"') },
    },
    ({ as, label }) => tool((attached) => runSlack(attached, "click", [label], { as })),
  );
  mcp.registerTool(
    "slack_stop",
    {
      description: "Press Stop on the bot's work in a thread, as the person who started it (or `as`).",
      inputSchema: { as: person.optional(), thread: reference },
    },
    ({ as, thread }) => tool((attached) => runSlack(attached, "stop", [], { as, thread })),
  );
  mcp.registerTool(
    "show_thread",
    {
      description:
        "The latest Slack conversation as a person would read it; with `thread`, only that thread. `json` lists the entries with their ids.",
      inputSchema: { thread: reference, json: z.boolean().optional() },
    },
    ({ thread, json }) => tool((attached) => runShow(attached, { thread, json })),
  );
  mcp.registerTool(
    "list_deliveries",
    {
      description:
        "What channelstack delivered to the bot: each delivery's id, event, outcome and attempts. Every channel's, or one channel's.",
      inputSchema: { channel: z.enum(DELIVERY_CHANNELS).optional() },
    },
    ({ channel }) => tool((attached) => runDeliveries(attached, channel)),
  );
  mcp.registerTool(
    "redeliver",
    {
      description:
        "Deliver an event to the bot again, the way the platform does (Slack retries it): the newest delivery, or one by its id from list_deliveries.",
      inputSchema: {
        channel: z.enum(DELIVERY_CHANNELS).optional(),
        delivery: z.string().min(1).optional().describe('"last" (the default) or an id from list_deliveries'),
      },
    },
    ({ channel, delivery }) =>
      tool((attached) =>
        runRedeliver(
          attached,
          [channel, delivery].filter((arg) => arg !== undefined),
        ),
      ),
  );

  // `tail` remembers where it got to on each attachment: each call returns what happened since the
  // last one. A new attachment (another server, or the same one restarted) starts from its beginning.
  const cursors = new WeakMap<Attached, string>();
  mcp.registerTool(
    "tail",
    {
      description:
        "What happened since the last call (everything, the first time): events delivered to the bot (→) and its API calls (←).",
      inputSchema: {},
    },
    () =>
      tool(async (attached) => {
        const read = await readEvents(attached, cursors.get(attached));
        cursors.set(attached, read.cursor);
        return read.text || "Nothing new.\n";
      }),
  );
  return mcp;
}

/** Serve the tools over stdin and stdout until the client hangs up. stdout belongs to the protocol. */
export async function runMcp(flags: AttachFlags, version: string): Promise<void> {
  await mcpServer(flags, version).connect(new StdioServerTransport());
}
