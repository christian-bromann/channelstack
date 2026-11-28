import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { DEV_CHANNELS } from "../drivers/index.ts";
import { actionsOf, describeAction, runAct } from "./act.ts";
import { attach, type Attached, type AttachFlags, CliError, ServerGoneError } from "./attach.ts";
import { DELIVERY_CHANNELS, runDeliveries, runRedeliver } from "./deliveries.ts";
import { devChannel, runReact, runReply, runSay, runShow } from "./dev.ts";
import { runOpenAI } from "./openai.ts";
import { readEvents } from "./watch.ts";

/** What a reference is, in every tool that takes one. */
const REFERENCE =
  '"last" (the default: the newest entry of the most recently active place), "<place>:<entry>" as the tools print them and `show` with `json` lists the entries, or a place by name';
const reference = z.string().min(1).optional().describe(REFERENCE);
const person = z.string().min(1).describe("Who acts, by name, e.g. ana. Created the first time the name is used");
const channelName = z.enum(DEV_CHANNELS.map(({ name }) => name) as [string, ...string[]]);
const PLACES = DEV_CHANNELS.map(({ title, adapter }) => `${title}: a ${adapter.place}, e.g. ${adapter.example}`).join(
  "; ",
);

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
    "say",
    {
      description: `Say something in a place as a person, e.g. to mention the bot. The place is made, with the person and the bot in it, the first time its name is used (${PLACES}).`,
      inputSchema: {
        channel: channelName,
        as: person,
        in: z.string().min(1).describe("The place, by name"),
        text: z.string().min(1).describe('What they say, e.g. "@my-agent summarize today"'),
      },
    },
    ({ channel, as, in: where, text }) =>
      tool((attached) => runSay(attached, devChannel(channel), text, { as, in: where })),
  );
  mcp.registerTool(
    "reply",
    {
      description:
        "Reply to an entry as a person: in its thread where the channel has threads, otherwise in its place.",
      inputSchema: { channel: channelName, as: person, text: z.string().min(1), to: reference },
    },
    ({ channel, as, text, to }) => tool((attached) => runReply(attached, devChannel(channel), text, { as, to })),
  );
  mcp.registerTool(
    "react",
    {
      description: `React to an entry with an emoji, as a person. On ${DEV_CHANNELS.filter(
        ({ adapter }) => adapter.react,
      )
        .map(({ title }) => title)
        .join(", ")}.`,
      inputSchema: {
        channel: channelName,
        as: person,
        emoji: z.string().min(1).describe('e.g. ":eyes:"'),
        on: reference,
      },
    },
    ({ channel, as, emoji, on }) => tool((attached) => runReact(attached, devChannel(channel), emoji, { as, on })),
  );
  mcp.registerTool(
    "show",
    {
      description:
        "A place as a person reads it: the most recently active one (on any channel, without `channel`), the one `in` names, or with `thread` only that entry's thread. `json` lists the entries with their ids.",
      inputSchema: {
        channel: channelName.optional(),
        in: z.string().min(1).optional().describe("A place, by name"),
        thread: reference,
        json: z.boolean().optional(),
      },
    },
    ({ channel, in: where, thread, json }) =>
      tool((attached) =>
        runShow(attached, channel === undefined ? undefined : devChannel(channel), { in: where, thread, json }),
      ),
  );
  // One tool per channel for everything else its people do, generated from its routes.
  for (const channel of DEV_CHANNELS) {
    const actions = actionsOf(channel.name);
    const [first, ...others] = actions.map((action) => action.name);
    if (first === undefined) continue;
    mcp.registerTool(
      `${channel.name}_act`,
      {
        description: [
          `Act on ${channel.title} as a person. References the action needs and isn't given (the message, the issue, the app) are the target's: the entry \`on\` names, the newest one in the place \`in\` names, or the newest anywhere on ${channel.title}. A person or the app is given by name, a reference as "last" or an id. Without \`as\`, whoever started the target's thread acts.`,
          "Actions, with the values `params` takes (? is optional):",
          ...actions.map((action) => `- ${describeAction(action)}`),
        ].join("\n"),
        inputSchema: {
          action: z.enum([first, ...others]),
          as: person.optional(),
          in: z
            .string()
            .min(1)
            .optional()
            .describe(`A ${channel.adapter.place} by name, e.g. ${channel.adapter.example}`),
          on: reference,
          params: z.record(z.string(), z.unknown()).optional().describe("The action's values by name"),
        },
      },
      ({ action, as, in: where, on, params }) =>
        tool((attached) =>
          runAct(attached, channel, action, { positional: [], values: params ?? {}, flags: { as, in: where, on } }),
        ),
    );
  }
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

  mcp.registerTool(
    "openai_respond",
    {
      description:
        "Script what the fake OpenAI answers the bot's next model calls in the dev session (decision 0029). The text may use {lastUserText} and {toolResult}. With `tool`, the model calls that tool first, with `args`, and the text answers its result.",
      inputSchema: {
        text: z.string().optional(),
        when: z.string().min(1).optional().describe("Only calls whose newest user message has this text"),
        times: z.number().int().optional().describe("How many calls it answers; -1 for all"),
        tool: z.string().min(1).optional(),
        args: z.string().optional().describe("The tool's arguments, as JSON"),
      },
    },
    ({ text, when, times, tool: toolName, args }) =>
      tool((attached) =>
        runOpenAI(attached, "respond", text === undefined ? [] : [text], {
          when,
          times: times === undefined ? undefined : String(times),
          tool: toolName,
          args,
        }),
      ),
  );
  mcp.registerTool(
    "openai_calls",
    {
      description: "The bot's model calls in the dev session: what it asked, and what the fake OpenAI answered.",
      inputSchema: {},
    },
    () => tool((attached) => runOpenAI(attached, "calls", [], {})),
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
