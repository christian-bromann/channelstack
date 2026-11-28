import { DEV_CHANNELS, DRIVERS } from "../drivers/index.ts";
import { actionsOf, paramText, VERBS } from "./act.ts";
import type { DevChannel } from "./dev.ts";
import type { Action } from "./generated/actions.ts";

/**
 * The command tree: every command's summary, usage, flags and examples. `channelstack … --help`
 * prints a command's own part of it, and the same tree says which flags each command takes, so
 * the help and what the parser accepts can't drift apart.
 */

/** A flag a command takes. With `value` it takes one (`--as <name>`); without, it is a switch. */
export interface Flag {
  readonly name: string;
  readonly value?: string;
  readonly short?: string;
  readonly text: string;
  readonly multiple?: true;
  /** Taken, but not shown: another spelling of a shown flag. */
  readonly hidden?: true;
}

interface Row {
  readonly name: string;
  readonly text: string;
}

interface Example {
  readonly command: string;
  readonly note?: string;
}

export interface Command {
  readonly name: string;
  /** One line, for the parent's list. */
  readonly summary: string;
  /** The first line of its own help, when it says more than the summary. */
  readonly about?: string;
  /** Paragraphs under the summary in the command's own help. */
  readonly description?: readonly string[];
  readonly usage?: readonly string[];
  readonly examples?: readonly Example[];
  readonly args?: readonly Row[];
  /** Flag groups, each under its heading (`FLAGS`, `VALUES`). */
  readonly flags?: ReadonlyArray<{ readonly title: string; readonly flags: readonly Flag[] }>;
  /** It talks to the running server, so it takes `--server` and `--server-file`. */
  readonly attaches?: true;
  readonly commands?: ReadonlyArray<{ readonly title: string; readonly commands: readonly Command[] }>;
  readonly sections?: ReadonlyArray<{ readonly title: string; readonly rows: readonly Row[] }>;
  /** Where its reference is: an anchor on the CLI page. */
  readonly docs?: string;
  /** Found and run, but not listed: a command that only says why it can't be used here. */
  readonly hidden?: true;
}

const DOCS = "https://channelstack.dev/docs/reference/cli";

/** A command's line in the help, `--as <name>` or `-h, --help`. */
const flagName = (flag: Flag) =>
  `${flag.short ? `-${flag.short}, ` : ""}--${flag.name}${flag.value ? ` <${flag.value}>` : ""}`;

/** "a channel", "an issue". */
const a = (word: string) => `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;

const list = (items: readonly string[], last = "or") =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${last} ${items.at(-1)}`;

/** Up to the first full stop that ends a sentence (not the one in "e.g."). */
const firstSentence = (text: string) => text.match(/^.*?[.!?](?=\s+[A-Z]|$)/)?.[0].replace(/\.$/, "") ?? text;

// --- Shared flags ----------------------------------------------------------------------------

const HELP: Flag = { name: "help", short: "h", text: "Show help for any command (also `channelstack help <command>`)" };
const VERSION: Flag = { name: "version", short: "v", text: "Print the version" };

const SERVER_FLAGS: readonly Flag[] = [
  {
    name: "server",
    value: "url",
    text: "The server to attach to (default: CHANNELSTACK_URL, else the server file's)",
  },
  {
    name: "server-file",
    value: "path",
    text: "The server file with its URL and token (default <home>/server.json)",
  },
];

const ENVIRONMENT: readonly Row[] = [
  {
    name: "CHANNELSTACK_HOME",
    text: "State directory: secrets, CA, server file, browser sessions (default ~/.channelstack)",
  },
  { name: "CHANNELSTACK_SEED", text: "Makes generated ids reproducible" },
  { name: "CHANNELSTACK_URL", text: "The server to attach to, with CHANNELSTACK_TOKEN (default: the server file's)" },
  { name: "CHANNELSTACK_<CHANNEL>_WEBHOOK_URL", text: "Where the agent receives that channel's events" },
  {
    name: "CHANNELSTACK_<CHANNEL>_APP_<NAME>_WEBHOOK_URL",
    text: "Where another app's events go (`coder` is CODER)",
  },
];

const channelNames = DEV_CHANNELS.map((channel) => channel.name);

// --- The server ------------------------------------------------------------------------------

const start: Command = {
  name: "start",
  summary: "Start the server (the default command)",
  description: [
    "Runs in the foreground until Ctrl-C, SIGTERM or SIGHUP, then stops cleanly. Prints each fake's address and a one-time link to the UI. Everything is in memory: a restart starts fresh.",
  ],
  usage: ["channelstack [start] [flags]"],
  examples: [
    { command: "channelstack start", note: "On https://*.localhost names, through portless" },
    { command: "channelstack start --no-portless --port 4500", note: "On one loopback port, with path prefixes" },
    {
      command: "channelstack start --proxy",
      note: "For an agent with hard-coded hosts (slack.com, api.github.com, …)",
    },
  ],
  flags: [
    {
      title: "Flags",
      flags: [
        { name: "no-portless", text: "One loopback port with path prefixes, instead of *.localhost names" },
        { name: "port", value: "n", text: "The loopback port (default 4500 without portless; 0 picks a free one)" },
        {
          name: "server-file",
          value: "path",
          text: "Where to write the control API's URL and token (default CHANNELSTACK_SERVER_FILE, else <home>/server.json)",
        },
        { name: "log-level", value: "level", text: "debug, info, warn, error or silent (default info)" },
        {
          name: "proxy",
          text: "Also run an HTTP proxy: the platforms' real hosts go to the fakes, every other host passes through",
        },
        { name: "proxy-port", value: "n", text: "With --proxy: its loopback port (default 7464; 0 picks a free one)" },
        {
          name: "record",
          value: "dir",
          text: "With --proxy: write the shape of every exchange with those hosts, and of every webhook, to <dir>/shapes.jsonl (structure only, never a value)",
        },
      ],
    },
  ],
  sections: [{ title: "Environment", rows: ENVIRONMENT }],
  docs: "channelstack-start",
};

const env: Command = {
  name: "env",
  summary: "Print .env lines that point the agent at the running server",
  description: [
    "Tokens, signing secrets and URLs, as KEY=value lines, from the running server: they match how it was started.",
  ],
  usage: ["channelstack env [flags]"],
  examples: [
    { command: "channelstack env >> .env" },
    { command: "channelstack env --proxy", note: "For proxy mode: HTTPS_PROXY and the CA to trust" },
    { command: "channelstack env --app coder --channel slack", note: "A second agent's Slack app" },
  ],
  flags: [
    {
      title: "Flags",
      flags: [
        { name: "proxy", text: "For proxy mode: HTTPS_PROXY and the CA the agent trusts, instead of the API URLs" },
        {
          name: "app",
          value: "name",
          text: "Another app's lines, under the same keys (made the first time it is asked for)",
        },
        { name: "channel", value: "name", text: `Only that channel's lines: ${list(channelNames)}` },
      ],
    },
  ],
  attaches: true,
  docs: "channelstack-env",
};

const ui: Command = {
  name: "ui",
  summary: "Print a one-time link that opens the UI in a browser",
  description: ["The link signs one browser in, once. Each call prints a new one."],
  usage: ["channelstack ui [flags]"],
  attaches: true,
  docs: "channelstack-ui",
};

const mcp: Command = {
  name: "mcp",
  summary: "Serve the dev commands as MCP tools over stdio, for a coding agent",
  description: [
    "say, reply, react, show, <channel>_act, tail, list_deliveries, redeliver, openai_respond and openai_calls, in the same shared dev session as the CLI and the UI. It attaches on the first tool call, so it can start before the server.",
  ],
  usage: ["channelstack mcp [flags]"],
  examples: [{ command: "claude mcp add channelstack -- npx channelstack mcp", note: "Register it in Claude Code" }],
  attaches: true,
  docs: "channelstack-mcp",
};

// --- Watching --------------------------------------------------------------------------------

const show: Command = {
  name: "show",
  summary: "Print the most recently active place on any channel, as a person reads it",
  description: [
    "Edits applied, deletes removed, streamed chunks joined. `channelstack <channel> show --in <place>` prints a given place.",
  ],
  usage: ["channelstack show [flags]"],
  examples: [{ command: "channelstack show" }, { command: "channelstack show --thread last --json" }],
  flags: [
    {
      title: "Flags",
      flags: [
        { name: "thread", value: "ref", text: "Only that entry's thread (`last` is the newest entry)" },
        { name: "json", text: "The entries as JSON, with their ids, authors and controls" },
      ],
    },
  ],
  attaches: true,
  docs: "channelstack-show",
};

const tail: Command = {
  name: "tail",
  summary: "Follow the events to the agent and its API calls, as they happen",
  description: [
    "One line each: deliveries to the agent marked →, its API calls ←, with UTC times. Runs until interrupted.",
  ],
  usage: ["channelstack tail [flags]"],
  flags: [{ title: "Flags", flags: [{ name: "once", text: "Print what is there and exit, instead of following" }] }],
  attaches: true,
  docs: "channelstack-tail",
};

const deliveries: Command = {
  name: "deliveries",
  summary: "List what was delivered to the agent: ids, events, outcomes, attempts",
  description: [
    "Oldest first, one line each. Without a channel, every channel's, each line starting with its channel.",
  ],
  usage: ["channelstack deliveries [<channel>]"],
  examples: [{ command: "channelstack deliveries slack" }],
  args: [{ name: "<channel>", text: `Only this channel's: ${list(channelNames)}` }],
  attaches: true,
  docs: "channelstack-deliveries",
};

const redeliver: Command = {
  name: "redeliver",
  summary: "Deliver something to the agent again, the way the platform does",
  description: ["On Slack it is a retry, with X-Slack-Retry-Num; on the others a redelivery."],
  usage: ["channelstack redeliver [<channel>] [last|<id>]"],
  examples: [{ command: "channelstack redeliver", note: "The newest delivery, of any channel" }],
  args: [
    { name: "<channel>", text: `Look only at this channel: ${list(channelNames)}` },
    { name: "last|<id>", text: "The newest delivery (the default), or an id `channelstack deliveries` printed" },
  ],
  attaches: true,
  docs: "channelstack-redeliver",
};

// --- The fake model --------------------------------------------------------------------------

const openai: Command = {
  name: "openai",
  summary: "Script the fake OpenAI's answers, and read the agent's model calls",
  description: [
    "A model call that no script answers fails with a 400 (channelstack_no_script), so an agent on the fake model needs a script before it can answer.",
  ],
  usage: ["channelstack openai <command> [flags]"],
  examples: [
    { command: 'channelstack openai respond "Restarted the deploy."' },
    { command: "channelstack openai calls" },
  ],
  commands: [
    {
      title: "Commands",
      commands: [
        {
          name: "respond",
          summary: "Script what the model answers the agent's next calls",
          description: [
            "Scripts are tried in the order they were added. Prints the script's id, for `channelstack openai undo`.",
          ],
          usage: ["channelstack openai respond [<text>] [flags]"],
          examples: [
            { command: 'channelstack openai respond "You asked: {lastUserText}"', note: "Echo the question back" },
            { command: 'channelstack openai respond "Paged on-call" --when "page" --times -1' },
            {
              command: `channelstack openai respond --tool page_oncall --args '{"team":"infra"}' "Done: {toolResult}"`,
              note: "Call a tool first, then answer its result",
            },
          ],
          args: [
            {
              name: "<text>",
              text: "The answer. {lastUserText} is the call's newest user message, {toolResult} what the agent sent back from a tool",
            },
          ],
          flags: [
            {
              title: "Flags",
              flags: [
                { name: "when", value: "text", text: "Answer only calls whose newest user message has this text" },
                {
                  name: "times",
                  value: "n",
                  text: "How many calls it answers (default: one per turn; -1: every matching call)",
                },
                {
                  name: "tool",
                  value: "name",
                  text: "The model calls this tool first; the text answers the call with its result",
                },
                { name: "args", value: "json", text: "With --tool: the tool call's arguments, as JSON (default {})" },
              ],
            },
          ],
          attaches: true,
          docs: "channelstack-openai-respond",
        },
        {
          name: "calls",
          summary: "List the agent's model calls and what the model answered, oldest first",
          usage: ["channelstack openai calls"],
          attaches: true,
          docs: "channelstack-openai-calls",
        },
        {
          name: "undo",
          summary: "Remove a script",
          usage: ["channelstack openai undo <script>"],
          args: [{ name: "<script>", text: "The id `channelstack openai respond` printed (ms_…)" }],
          attaches: true,
          docs: "channelstack-openai-undo",
        },
      ],
    },
  ],
  docs: "channelstack-openai-respond",
};

// --- Live mode -------------------------------------------------------------------------------

const signInChannels = DRIVERS.filter((driver) => driver.live?.maintenance?.signIn).map((driver) => driver.name);

const doctor: Command = {
  name: "doctor",
  summary: "Check which channels run live, their credentials and allowlists, and saved browser sessions",
  description: [
    "Live credentials come from the environment. It prints variable names and token prefixes, never a credential, and exits 1 when a line is FAIL.",
  ],
  usage: ["channelstack doctor [flags]"],
  flags: [
    {
      title: "Flags",
      flags: [
        {
          name: "storage-state",
          value: "path",
          multiple: true,
          text: "A saved browser session to check, besides those in <home>/browser (repeatable)",
        },
      ],
    },
  ],
  docs: "channelstack-doctor",
};

const login: Command = {
  name: "login",
  summary: "Sign a sandbox person in by hand, once, and save the session for the browser actor",
  description: [
    "Opens a browser window at the live workspace's sign-in page; channelstack never types or sees a password. Saves the session to <home>/browser/<channel>-<name>.json (0600). Waits up to 10 minutes.",
  ],
  usage: ["channelstack login <channel> --user <name> [flags]"],
  examples: [{ command: "channelstack login slack --user ana --save .auth/ana-slack.json" }],
  args: [{ name: "<channel>", text: `The live channel: ${list(signInChannels)}` }],
  flags: [
    {
      title: "Flags",
      flags: [
        { name: "user", value: "name", text: "The sandbox person, e.g. ana (required)" },
        { name: "save", value: "path", text: "Also save the session here, for a test that names it" },
      ],
    },
  ],
  docs: "channelstack-login",
};

const sweep: Command = {
  name: "sweep",
  summary: "Remove what crashed live runs left behind",
  description: [
    "What crashed servers' ledgers still list, and objects carrying a run's tag that nobody removed, in allowlisted workspaces only. Exits 1 when anything is left.",
  ],
  usage: ["channelstack sweep [flags]"],
  examples: [{ command: "channelstack sweep --check", note: "For a nightly job: fail when anything is left" }],
  flags: [
    {
      title: "Flags",
      flags: [
        { name: "older-than-hours", value: "n", text: "Only tagged objects older than this (default 24)" },
        { name: "run", value: "id", text: "Only what this run made, of any age" },
        { name: "check", text: "Remove nothing; report what is left" },
      ],
    },
  ],
  docs: "channelstack-sweep",
};

// --- Maintenance -----------------------------------------------------------------------------

const rotating = (name: string, summary: string, description: string, docs: string): Command => ({
  name,
  summary,
  usage: [`channelstack ${name} rotate`],
  commands: [
    {
      title: "Commands",
      commands: [{ name: "rotate", summary, description: [description], usage: [`channelstack ${name} rotate`], docs }],
    },
  ],
  docs,
});

const secrets = rotating(
  "secrets",
  "Replace every fake token and signing secret",
  "In <home>/secrets.json. Restart the server and run `channelstack env` again.",
  "channelstack-secrets-rotate",
);

const ca = rotating(
  "ca",
  "Replace proxy mode's CA",
  "In <home>/ca. Restart the server; agents keep trusting the new one from the same files.",
  "channelstack-ca-rotate",
);

// --- The channels ----------------------------------------------------------------------------

const AS: Flag = { name: "as", value: "name", text: "Who acts, by name. Made the first time the name is used" };

/** The references every channel command takes, in its own words. */
const referenceText = (channel: DevChannel) =>
  `\`last\` is the newest entry of the most recently active ${channel.adapter.place}; \`<place>:<entry>\`, as commands print them, names any entry, and ${a(channel.adapter.place)} by its name stands for its newest entry.`;

/** The channel's actions that a verb's name hides: they run as `act <action>`. */
const shadowed = (channel: DevChannel) =>
  actionsOf(channel.name).filter((action) => (VERBS as readonly string[]).includes(action.name));

/** `channelstack <channel> <action>`: what the action does and the values it takes, from the routes. */
function actionCommand(channel: DevChannel, action: Action, prefix: string): Command {
  const positional = action.params.filter((param) => param.positional);
  const ordinal = (at: number) => ["1st", "2nd", "3rd"][at] ?? `${at + 1}th`;
  const usage = [
    `channelstack ${prefix} ${action.name}`,
    ...positional.map((param) => (param.optional ? `[<${param.name}>]` : `<${param.name}>`)),
    "[flags]",
  ].join(" ");
  const values = action.params.map((param): Flag => {
    const at = positional.indexOf(param);
    const notes = [
      param.optional ? undefined : "required",
      at >= 0 ? `or the ${ordinal(at)} argument` : undefined,
    ].filter(Boolean);
    return {
      name: param.name,
      value: "value",
      text: `${paramText(param)}${notes.length > 0 ? `; ${notes.join(", ")}` : ""}`,
    };
  });
  return {
    name: action.name,
    summary: firstSentence(action.summary),
    about: action.summary,
    description: [
      "A value is read as its type: a number, true or false, JSON for an object or a list, and a value with a shorthand as that text. A person is named, the agent's app is `app` or its name, and a handle is `last` or an id (`<field>:<field>` for one with several). A reference the action needs and isn't given comes from the target.",
    ],
    usage: [usage],
    flags: [
      { title: "Values", flags: values },
      {
        title: "Flags",
        flags: [
          { ...AS, text: "Who acts (default: whoever started the target's thread)" },
          {
            name: "in",
            value: "place",
            text: `The target is the newest entry of this ${channel.adapter.place}, e.g. ${channel.adapter.example} (made the first time)`,
          },
          { name: "on", value: "ref", text: "The target is this entry (default: last)" },
          { name: "json", text: "Print the whole answer as JSON" },
        ],
      },
    ],
    attaches: true,
    docs: "channelstack-channel-action",
  };
}

/** `channelstack <channel>`: the shared commands, then the channel's own actions, generated from its routes. */
function channelCommand(channel: DevChannel): Command {
  const { name, title, adapter } = channel;
  const actions = actionsOf(name);
  const hidden = shadowed(channel);
  const own = actions.filter((action) => !hidden.includes(action));
  const ownName = (verb: string) =>
    hidden.some((action) => action.name === verb)
      ? [`${title}'s own ${verb} action, with all its values: \`channelstack ${name} act ${verb} --help\`.`]
      : [];

  const say: Command = {
    name: "say",
    summary: `Say something in ${a(adapter.place)} as a person`,
    description: [
      `The ${adapter.place} is made the first time it is named, with the person and the app in it, and the text as the person's first words there. @name in the text becomes a real mention.`,
      ...ownName("say"),
    ],
    usage: [`channelstack ${name} say --as <name> --in <place> <text>`],
    examples: [{ command: `channelstack ${name} say --as ana --in ${adapter.example} "@my-agent hi"` }],
    args: [{ name: "<text>", text: "What they say" }],
    flags: [
      {
        title: "Flags",
        flags: [
          { ...AS, text: `${AS.text} (required)` },
          { name: "in", value: "place", text: `The ${adapter.place}, by its name, e.g. ${adapter.example} (required)` },
        ],
      },
    ],
    attaches: true,
    docs: "channelstack-channel-say",
  };
  const reply: Command = {
    name: "reply",
    summary: "Reply to an entry as a person",
    description: [
      "In the entry's thread where the channel has them, otherwise next to it.",
      referenceText(channel),
      ...ownName("reply"),
    ],
    usage: [`channelstack ${name} reply --as <name> [--to last|<ref>] <text>`],
    examples: [{ command: `channelstack ${name} reply --as ben "and then?"` }],
    args: [{ name: "<text>", text: "What they reply" }],
    flags: [
      {
        title: "Flags",
        flags: [
          { ...AS, text: `${AS.text} (required)` },
          { name: "to", value: "ref", text: "The entry to answer (default: last)" },
          { name: "thread", value: "ref", text: "", hidden: true },
        ],
      },
    ],
    attaches: true,
    docs: "channelstack-channel-reply",
  };
  // On a channel whose people don't react, `react` is kept out of the help but still runs, to say so.
  const react: Command = {
    ...(adapter.react ? {} : { hidden: true as const, about: `People don't react on ${title}.` }),
    name: "react",
    summary: "React to an entry with an emoji as a person",
    description: [referenceText(channel), ...ownName("react")],
    usage: [`channelstack ${name} react --as <name> <emoji> [--on last|<ref>]`],
    examples: [{ command: `channelstack ${name} react --as ben :eyes:` }],
    args: [{ name: "<emoji>", text: "The emoji, e.g. :eyes:" }],
    flags: [
      {
        title: "Flags",
        flags: [
          { ...AS, text: `${AS.text} (required)` },
          { name: "on", value: "ref", text: "The entry (default: last)" },
          { name: "to", value: "ref", text: "", hidden: true },
        ],
      },
    ],
    attaches: true,
    docs: "channelstack-channel-react",
  };
  const showPlace: Command = {
    name: "show",
    summary: `Print ${a(adapter.place)} as a person reads it`,
    description: [
      `Without --in, the most recently active ${adapter.place}. Edits applied, deletes removed, streamed chunks joined.`,
    ],
    usage: [`channelstack ${name} show [flags]`],
    examples: [{ command: `channelstack ${name} show --in ${adapter.example}` }],
    flags: [
      {
        title: "Flags",
        flags: [
          { name: "in", value: "place", text: `The ${adapter.place}, by its name` },
          {
            name: "thread",
            value: "ref",
            text: adapter.thread
              ? "Only that entry's thread (`last` is the newest entry)"
              : `The ${adapter.place} that entry is in (${title} has no threads)`,
          },
          { name: "json", text: "The entries as JSON, with their ids, authors and controls" },
        ],
      },
    ],
    attaches: true,
    docs: "channelstack-channel-show",
  };
  const listActions: Command = {
    name: "actions",
    summary: "List every action with its values and their types, one a line",
    usage: [`channelstack ${name} actions`],
    attaches: true,
    docs: "channelstack-channel-actions",
  };
  const act: Command = {
    name: "act",
    summary: `Run any action by name, also ${list(
      hidden.map((action) => action.name),
      "and",
    )}, which the commands above hide`,
    usage: [`channelstack ${name} act <action> [<value>…] [flags]`],
    examples: hidden[0] ? [{ command: `channelstack ${name} act ${hidden[0].name} --help` }] : [],
    commands: [{ title: "Actions", commands: actions.map((action) => actionCommand(channel, action, `${name} act`)) }],
    attaches: true,
    docs: "channelstack-channel-action",
  };

  return {
    name,
    summary: `Act as people on ${title}: say, reply${adapter.react ? ", react" : ""}, show, and ${actions.length} actions`,
    description: [
      `In the running server's shared "dev" session. A place on ${title} is ${a(adapter.place)}, named like ${adapter.example}. People and places are made the first time they are named, with the app in them.`,
      referenceText(channel),
    ],
    usage: [`channelstack ${name} <command> [flags]`, `channelstack ${name} <action> [<value>…] [flags]`],
    examples: [
      { command: `channelstack ${name} say --as ana --in ${adapter.example} "@my-agent hi"` },
      { command: `channelstack ${name} show` },
      ...(own[0] ? [{ command: `channelstack ${name} ${own[0].name} --help`, note: "An action's values" }] : []),
    ],
    commands: [
      {
        title: "Commands",
        commands: [say, reply, react, showPlace, listActions, ...(hidden.length > 0 ? [act] : [])],
      },
      { title: "Actions", commands: own.map((action) => actionCommand(channel, action, name)) },
    ],
    attaches: true,
    docs: "channelstack-channel-say",
  };
}

// --- The root --------------------------------------------------------------------------------

const titles = DEV_CHANNELS.map((channel) => channel.title);

export const ROOT: Command = {
  name: "channelstack",
  summary: `Fake ${list(titles, "and")}, and a fake OpenAI, in one local server for testing AI agents`,
  description: [
    "Start the server, point the agent at it with `channelstack env`, then act as people from the terminal and read what the agent answered. Tests do the same through the SDKs.",
  ],
  usage: [
    "channelstack [start] [flags]",
    "channelstack <command> [<subcommand>] [flags]",
    "channelstack <channel> <command> [flags]",
  ],
  examples: [
    { command: "channelstack start", note: "Start the server, then point the agent at it" },
    { command: "channelstack env >> .env" },
    {
      command: 'channelstack slack say --as ana --in "#support" "@my-agent hi"',
      note: "Talk to the agent as a person",
    },
    { command: "channelstack show", note: "Read what it answered" },
  ],
  commands: [
    { title: "Server", commands: [start, env, ui, mcp] },
    { title: "Channels", commands: DEV_CHANNELS.map(channelCommand) },
    { title: "Model", commands: [openai] },
    { title: "Inspect", commands: [show, tail, deliveries, redeliver] },
    { title: "Live mode", commands: [doctor, login, sweep] },
    { title: "Maintenance", commands: [secrets, ca] },
  ],
  flags: [{ title: "Flags", flags: [HELP, VERSION] }],
  sections: [{ title: "Environment", rows: ENVIRONMENT }],
};

// --- Finding a command -----------------------------------------------------------------------

const children = (command: Command) => command.commands?.flatMap((group) => group.commands) ?? [];

/** Levenshtein distance, for suggesting the command or flag someone meant. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, at) => at);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

/** The candidate closest to what was typed, when it is close enough to be a typo. */
export function closest(typed: string, candidates: readonly string[]): string | undefined {
  const scored = candidates
    .map((candidate) => ({ candidate, score: distance(typed.toLowerCase(), candidate.toLowerCase()) }))
    .sort((a, b) => a.score - b.score);
  const best = scored[0];
  return best && best.score <= Math.max(2, Math.floor(typed.length / 3)) ? best.candidate : undefined;
}

/** A command and the path to it (`["slack", "click"]`), or what wasn't found and where. */
export type Found =
  | { readonly ok: true; readonly path: readonly Command[] }
  | { readonly ok: false; readonly path: readonly Command[]; readonly typed: string; readonly suggestion?: string };

/**
 * Walk the positionals down the tree for as long as there are subcommands: what is left is the
 * command's own arguments (`channelstack slack say "hi"` stops at `say`).
 */
export function find(words: readonly string[]): Found {
  const path: Command[] = [ROOT];
  for (const word of words) {
    const here = path.at(-1) as Command;
    const options = children(here);
    if (options.length === 0) break;
    const next = options.find((candidate) => candidate.name === word);
    if (!next) {
      const suggestion = closest(
        word,
        options.map((option) => option.name),
      );
      return { ok: false, path, typed: word, ...(suggestion ? { suggestion } : {}) };
    }
    path.push(next);
  }
  return { ok: true, path };
}

/** `channelstack slack click`, for messages. */
export const commandLine = (path: readonly Command[]) => path.map((command) => command.name).join(" ");

/** Every flag a command takes, by name: its own, the server's when it attaches, and `--help`. */
export function flagsOf(command: Command): Map<string, Flag> {
  const flags = [...(command.flags?.flatMap((group) => group.flags) ?? []), ...(command.attaches ? SERVER_FLAGS : [])];
  return new Map([...flags, HELP, ...(command === ROOT ? [VERSION] : [])].map((flag) => [flag.name, flag]));
}

/** What `parseArgs` takes: every flag any command takes, with its type. */
export function parseOptions(): Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }> {
  const options: Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }> = {};
  const visit = (command: Command) => {
    for (const flag of flagsOf(command).values()) {
      options[flag.name] = {
        type: flag.value ? "string" : "boolean",
        ...(flag.short ? { short: flag.short } : {}),
        ...(flag.multiple ? { multiple: true } : {}),
      };
    }
    for (const child of children(command)) visit(child);
  };
  visit(ROOT);
  // The root's version flag is read before any command is found.
  options[VERSION.name] = { type: "boolean", short: VERSION.short as string };
  return options;
}

// --- Rendering -------------------------------------------------------------------------------

const WIDTH = 80;

/**
 * Words wrapped to `width`, every line after the first indented by `indent`. A \`code span\` is
 * never broken, so a command in a sentence stays copyable.
 */
function wrap(text: string, width: number, indent: number): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.match(/(?:`[^`]*`|\S)+/g) ?? []) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join(`\n${" ".repeat(indent)}`);
}

/** Two columns: names, then their text, wrapped beside them. A long name gets its text on the next line. */
function rows(items: readonly Row[]): string[] {
  const column = Math.min(Math.max(...items.map((item) => item.name.length)) + 2, 28);
  return items.map((item) => {
    const text = wrap(item.text, WIDTH - 2 - column, 2 + column);
    if (!item.text) return `  ${item.name}`;
    return item.name.length + 2 > column
      ? `  ${item.name}\n${" ".repeat(2 + column)}${text}`
      : `  ${item.name.padEnd(column)}${text}`;
  });
}

/** How headings look: bold on a terminal that wants colour, plain otherwise (`NO_COLOR`, a pipe, an agent). */
export interface Style {
  readonly bold: boolean;
}

/** The help of the command at the end of `path`. */
export function renderHelp(path: readonly Command[], options: { version: string; style?: Style }): string {
  const command = path.at(-1) as Command;
  const line = commandLine(path);
  const heading = (title: string) => {
    const upper = title.toUpperCase();
    return options.style?.bold ? `\x1b[1m${upper}\x1b[22m` : upper;
  };
  const out: string[] = [];
  const section = (title: string, body: readonly string[]) => {
    if (body.length > 0) out.push("", heading(title), ...body);
  };

  const about = (command.about ?? `${command.summary}.`).replace(/([^.])$/, "$1.");
  out.push(wrap(command === ROOT ? `channelstack ${options.version}: ${command.summary}` : about, WIDTH, 0));
  for (const paragraph of command.description ?? []) out.push("", wrap(paragraph, WIDTH, 0));
  section(
    "Usage",
    (command.usage ?? [`${line}${children(command).length > 0 ? " <command>" : ""}`]).map((usage) => `  ${usage}`),
  );
  section(
    "Examples",
    (command.examples ?? []).flatMap((example) => [
      ...(example.note ? [`  # ${example.note}`] : []),
      `  ${example.command}`,
    ]),
  );
  for (const group of command.commands ?? []) {
    const listed = group.commands.filter((child) => !child.hidden);
    section(group.title, rows(listed.map((child) => ({ name: child.name, text: child.summary }))));
  }
  if (command.args) section("Arguments", rows(command.args));
  for (const group of command.flags ?? []) {
    const shown = group.flags.filter((flag) => !flag.hidden);
    section(group.title, rows(shown.map((flag) => ({ name: flagName(flag), text: flag.text }))));
  }
  if (command.attaches)
    section("Server flags", rows(SERVER_FLAGS.map((flag) => ({ name: flagName(flag), text: flag.text }))));
  for (const extra of command.sections ?? []) section(extra.title, rows(extra.rows));

  const more = [
    ...(children(command).length > 0
      ? [`  ${wrap(`Run \`${line} <command> --help\` for a command's flags and examples.`, WIDTH - 2, 2)}`]
      : []),
    `  ${DOCS}${command.docs ? `#${command.docs}` : ""}`,
  ];
  section("Learn more", more);
  return `${out.join("\n")}\n`;
}
