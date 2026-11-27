/**
 * A Slack agent that asks a model, as a developer would write one: it answers mentions, DMs and
 * follow-ups in a thread it is part of, sends the model the thread so far, runs the tools the
 * model calls, streams the answer into the thread, stops when the person presses Stop, and tells
 * the person when the model fails. Each reference agent plugs in its model (`Model`): the official
 * `openai` SDK, or the AI SDK. Nothing in it knows about channelstack: `OPENAI_BASE_URL` points it
 * at the fake.
 */
import type { App } from "@slack/bolt";

/** One message of the conversation the agent sends the model. */
export interface Turn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** What the model streams, step by step, until it answers without calling a tool. */
export interface Model {
  answer(options: {
    instructions: string;
    history: readonly Turn[];
    /** Who is asking: the Slack user, as OpenAI's `user`. */
    user: string;
    signal: AbortSignal;
    /** A piece of the answer, as it comes. */
    onText(text: string): Promise<void>;
  }): Promise<void>;
}

/** The tools the agent offers the model, and what running them gives. */
export const TOOLS = {
  search_incidents: {
    description: "Search the incident log",
    parameters: {
      type: "object",
      properties: { since: { type: "string" }, query: { type: "string" } },
      additionalProperties: false,
    },
    run: () => "The web deploy failed at the migration step at 14:02; a DNS blip at 02:10 resolved itself.",
  },
  page_oncall: {
    description: "Page a team's on-call engineer",
    parameters: { type: "object", properties: { team: { type: "string" } }, required: ["team"], additionalProperties: false },
    run: (args: { team?: string }) => `Paged ${args.team ?? "the"} on-call.`,
  },
} as const;

export type ToolName = keyof typeof TOOLS;

/** Run a tool the model called, with the arguments it gave. */
export const runTool = (name: string, args: unknown): string =>
  name in TOOLS ? TOOLS[name as ToolName].run((args ?? {}) as { team?: string }) : `No tool "${name}".`;

const INSTRUCTIONS = "You are my-agent, the team's assistant in Slack. Answer briefly. Use the tools for incidents and paging.";

/** Wire a model into a Bolt app. */
export function modelAgent(app: App, model: Model): void {
  /** Events Slack delivers more than once (a retry after a slow ack) are handled once. */
  const handled = new Set<string>();
  const firstTime = (eventId: string) => !handled.has(eventId) && handled.add(eventId).size > 0;
  /** Threads the agent answers in: it keeps answering follow-ups there without a new mention. */
  const joined = new Set<string>();
  /** What the agent is answering right now, by thread: Stop ends it. */
  const answering = new Map<string, AbortController>();

  app.event("agent_session_stopped", async ({ event }) => {
    const { channel, thread_ts: thread } = event as unknown as { channel: string; thread_ts: string };
    answering.get(`${channel}:${thread}`)?.abort();
  });

  /** The thread so far, as the model reads it: people's messages and the agent's own answers. */
  const historyOf = async (client: App["client"], channel: string, thread: string, self: string | undefined): Promise<Turn[]> => {
    const { messages = [] } = await client.conversations.replies({ channel, ts: thread });
    return messages.flatMap((message) =>
      message.text === undefined || message.text === ""
        ? []
        : [{ role: message.bot_id !== undefined || message.user === self ? ("assistant" as const) : ("user" as const), text: message.text }],
    );
  };

  const respond = async (client: App["client"], channel: string, thread: string, user: string, self: string | undefined) => {
    const key = `${channel}:${thread}`;
    joined.add(key);
    await client.assistant.threads.setStatus({ channel_id: channel, thread_ts: thread, status: "is thinking…" });
    const stop = new AbortController();
    answering.set(key, stop);
    let stream: string | undefined;
    try {
      const history = await historyOf(client, channel, thread, self);
      await model.answer({
        instructions: INSTRUCTIONS,
        history,
        user,
        signal: stop.signal,
        onText: async (text) => {
          if (stop.signal.aborted || text === "") return;
          if (stream === undefined) {
            stream = (await client.chat.startStream({ channel, thread_ts: thread, markdown_text: text })).ts;
          } else await client.chat.appendStream({ channel, ts: stream, markdown_text: text });
        },
      });
      if (stream !== undefined && !stop.signal.aborted) await client.chat.stopStream({ channel, ts: stream });
    } catch (error) {
      // Stop: Slack has ended the stream already.
      if (stop.signal.aborted || (error as { data?: { error?: string } }).data?.error === "stopped_by_user") return;
      // The model failed: the person hears so, once, and nothing is left streaming.
      const note = "Sorry, the model isn't answering right now. Please try again in a minute.";
      if (stream !== undefined) {
        await client.chat.appendStream({ channel, ts: stream, markdown_text: `\n\n_${note}_` }).catch(() => undefined);
        await client.chat.stopStream({ channel, ts: stream }).catch(() => undefined);
      } else {
        await client.chat.postMessage({ channel, thread_ts: thread, text: note });
      }
    } finally {
      answering.delete(key);
      if (stream === undefined) {
        await client.assistant.threads.setStatus({ channel_id: channel, thread_ts: thread, status: "" }).catch(() => undefined);
      }
    }
  };

  app.event("app_mention", async ({ event, body, client, context }) => {
    if ("bot_id" in event || !firstTime(body.event_id)) return;
    await respond(client, event.channel, event.thread_ts ?? event.ts, event.user ?? "", context.botUserId);
  });

  app.message(async ({ message, body, client, context }) => {
    // Only what a person newly wrote: not edits or deletes, not bots, not retries.
    if (message.subtype !== undefined || "bot_id" in message || !firstTime(body.event_id)) return;
    const thread = message.thread_ts ?? message.ts;
    const direct = message.channel_type === "im";
    const followUp = message.thread_ts !== undefined && joined.has(`${message.channel}:${thread}`);
    // A mention is answered by the app_mention handler.
    if ((!direct && !followUp) || ((message.text ?? "").includes("<@") && !direct)) return;
    await respond(client, message.channel, thread, message.user, context.botUserId);
  });
}
