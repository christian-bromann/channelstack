/**
 * The channel matchers, independent of any test framework. Each one reads plain SDK methods and
 * returns whether it passed and what to say if not; `integrations/vitest` only
 * adapt them to their `expect`.
 *
 * - A positive matcher polls until its condition holds, or fails after the timeout.
 * - A negated matcher, and one with an exact count, waits until the agent is quiet and checks once.
 */
import { createHash } from "node:crypto";

import {
  ChannelstackError,
  type DiscordChannel,
  type Duration,
  fromMatches,
  type InSession,
  ModelProblemError,
  parseDuration,
  QUIET,
  readMedia,
  type SlackConversation,
  textMatches,
  unreportedRefusals,
  untilQuiet,
  waitFor,
  WaitTimeoutError,
} from "../../sdks/typescript/client.ts";
import { CONTEXT, type WithContext } from "../../sdks/typescript/runtime/client.ts";
import { segment } from "../../sdks/typescript/runtime/transport.ts";
import { normalisedText } from "../../sdks/typescript/runtime/wait.ts";

export interface MatcherResult {
  pass: boolean;
  /** Why it failed (or, for a negated matcher, why it unexpectedly passed). */
  message: () => string;
}

export interface MatcherState {
  /** True under `.not`. */
  isNot: boolean;
  /** The test framework's own equality, which understands asymmetric matchers (`expect.any(Number)`). */
  equals?: (actual: unknown, expected: unknown) => boolean;
  /** Defaults from the integration's options. */
  timeout: Duration;
  quietFor: Duration;
}

interface Timing {
  timeout?: Duration;
  quietFor?: Duration;
}

type Author = { readonly id: string; readonly name: string };
type AuthorRef = Author | string;

interface Message {
  readonly author: Author;
  readonly text: string;
  readonly ts?: string;
  readonly stream?: { readonly state: string } | undefined;
}

interface TranscriptEntry {
  readonly id?: string;
  readonly author: Author & { readonly kind?: string };
  readonly text: string;
  readonly controls: readonly string[];
  readonly streaming?: string | undefined;
}

/**
 * Who a transcript is read as, in the channels that show some messages to one person only (Slack's
 * and Discord's ephemeral ones): the SDK's own types, so a change to that signature fails to compile here.
 */
type ViewerOf<Handle extends { transcript(options?: { as?: unknown }): unknown }> = NonNullable<
  NonNullable<Parameters<Handle["transcript"]>[0]>["as"]
>;
type Viewer = ViewerOf<SlackConversation> | ViewerOf<DiscordChannel>;

interface HasTranscript {
  transcript(options?: { as?: Viewer }): Promise<{ entries: readonly TranscriptEntry[] }>;
}

interface Attempt {
  readonly status: string;
  readonly responseStatus?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly forgedSignature: boolean;
}

interface Delivery {
  readonly id: string;
  refresh(): Promise<{ readonly attempts: readonly Attempt[] }>;
}

const nameOf = (author: AuthorRef) => (typeof author === "string" ? author : author.name);
const show = (expected: string | RegExp) =>
  typeof expected === "string" ? JSON.stringify(expected) : String(expected);
const listing = (lines: readonly string[]) =>
  lines.length === 0 ? "  (nothing)" : lines.map((line) => `  ${line}`).join("\n");
const says = (messages: readonly Message[]) =>
  listing(messages.map((message) => `${message.author.name}: ${message.text}`));

/**
 * What was said in a subject: a thread's replies, or, for a conversation (a DM), everything in
 * it, threads included, as its transcript has it.
 */
async function messagesOf(subject: unknown): Promise<readonly Message[]> {
  const handle = subject as { replies?: () => Promise<Message[]> } & Partial<HasTranscript>;
  if (typeof handle.replies === "function") return handle.replies();
  // A transcript entry says `streaming`; a message has a `stream`. Here they read the same.
  if (typeof handle.transcript === "function") {
    return (await handle.transcript()).entries.map((entry) => ({
      ...entry,
      stream: entry.streaming === undefined ? undefined : { state: entry.streaming },
    }));
  }
  throw new TypeError("This matcher needs a thread or a conversation");
}

/**
 * Run a check the way its kind needs: poll until it holds, or wait for quiet and check once.
 * `describe` says what was expected and what was there instead.
 */
async function settle<T>(
  subject: unknown,
  state: MatcherState,
  timing: Timing | undefined,
  options: { onceQuiet: boolean; read: () => Promise<T>; holds: (value: T) => boolean; describe: (value: T) => string },
): Promise<MatcherResult> {
  const timeout = timing?.timeout ?? state.timeout;
  let value: T;
  if (options.onceQuiet || state.isNot) {
    const handle = subject as Partial<InSession>;
    if (typeof handle[QUIET] !== "function") throw new TypeError("This matcher needs a channelstack handle");
    // The check watches for the whole quiet window: what arrives while it looks counts.
    try {
      await untilQuiet(() => (handle as InSession)[QUIET](), {
        timeout,
        quietFor: timing?.quietFor ?? state.quietFor,
        watching: true,
      });
    } catch (error) {
      if (error instanceof ModelProblemError) return failing(subject, state, error.message);
      throw error;
    }
    value = await options.read();
  } else {
    let last: T | undefined;
    let polls = 0;
    try {
      value = await waitFor(
        "the condition",
        async () => {
          last = await options.read();
          if (options.holds(last)) return last;
          // A model call no script answered won't be answered by waiting: fail now, with why.
          polls += 1;
          if (polls % 5 === 0) await failOnProblems(subject);
          return undefined;
        },
        { timeout },
      );
    } catch (error) {
      if (error instanceof ModelProblemError) return failing(subject, state, error.message);
      if (!(error instanceof WaitTimeoutError)) throw error;
      value = last as T;
      // A timeout whose cause is a model problem says so.
      try {
        await failOnProblems(subject);
      } catch (problem) {
        if (problem instanceof ModelProblemError) return failing(subject, state, problem.message);
        throw problem;
      }
    }
  }
  const pass = options.holds(value);
  if (pass !== state.isNot) return { pass, message: () => options.describe(value) };
  // A failed check also says what the agent left open (a stream it never stopped): often that is the bug.
  const open = await stillOpen(subject);
  const loops = await stoppedLoops(subject);
  const leftover = `${open.length === 0 ? "" : `\nStill open: ${open.join("; ")}`}${loops.length === 0 ? "" : `\nStopped: ${loops.join("; ")}`}`;
  return failing(subject, state, `${options.describe(value)}${leftover}`);
}

/** A failed check, its message followed by what the session's model calls say about it. */
async function failing(subject: unknown, state: MatcherState, message: string): Promise<MatcherResult> {
  const notes = await modelNotesOf(subject);
  const text = notes.length === 0 ? message : `${message}\n${notes.join("\n")}`;
  return { pass: state.isNot, message: () => text };
}

/** How recent a model call no session claimed must be for a failing check to name it (design §8.4). */
const UNATTRIBUTED_WITHIN_MS = 10_000;

/** A model call no session claimed, as `GET /sessions/{sid}/openai/unattributed` lists it. */
interface UnattributedCall {
  readonly id: string;
  readonly lastUserText?: string | undefined;
  readonly sinceMs: number;
  readonly message: string;
}

/** A model call of the session, as far as its attribution goes. */
interface AttributedCall {
  readonly id: string;
  readonly request: {
    readonly context: {
      readonly attributedBy?: string | undefined;
      readonly matched?: string | undefined;
      readonly tiedWith?: readonly string[] | undefined;
    };
  };
}

/**
 * What the session's model calls add to a failing check's message: the recent calls no session
 * claimed, and the calls given to this session only by order, between sessions that sent the same
 * text. Nothing for a subject outside a session, or where the server can't tell (live).
 */
async function modelNotesOf(subject: unknown): Promise<string[]> {
  const handle = subject as Partial<WithContext>;
  if (typeof handle[CONTEXT] !== "function") return [];
  const context = handle[CONTEXT]();
  if (context.session === undefined) return [];
  const base = `/sessions/${segment(context.session)}/openai`;
  try {
    const [unattributed, calls] = await unreportedRefusals(() =>
      Promise.all([
        context.transport.request("GET", `${base}/unattributed`, { query: { withinMs: UNATTRIBUTED_WITHIN_MS } }),
        context.transport.request("GET", `${base}/calls`),
      ]),
    );
    return modelNotes(unattributed as UnattributedCall[], calls as AttributedCall[]);
  } catch (error) {
    if (error instanceof ChannelstackError) return [];
    throw error;
  }
}

/** The lines of `modelNotesOf`, from what the server answered. */
export function modelNotes(unattributed: readonly UnattributedCall[], calls: readonly AttributedCall[]): string[] {
  const notes: string[] = [];
  if (unattributed.length > 0) {
    const count = unattributed.length === 1 ? "1 model call" : `${unattributed.length} model calls`;
    notes.push(
      `${count} in the last ${UNATTRIBUTED_WITHIN_MS / 1000}s couldn't be attributed to a test:\n${listing(
        unattributed.map(
          (call) =>
            `${call.id} (${call.lastUserText === undefined ? "no user message" : JSON.stringify(excerptOf(call.lastUserText))}, ${Math.round(call.sinceMs / 1000)}s ago): ${call.message}`,
        ),
      )}`,
    );
  }
  // One line per text the sessions shared, naming every call it decided.
  const tied = new Map<string, { ids: string[]; with: readonly string[] }>();
  for (const call of calls) {
    const { attributedBy, matched, tiedWith } = call.request.context;
    if (attributedBy !== "order" || tiedWith === undefined || tiedWith.length === 0) continue;
    const text = matched ?? "";
    const entry = tied.get(text) ?? { ids: [], with: tiedWith };
    entry.ids.push(call.id);
    tied.set(text, entry);
  }
  for (const [text, entry] of tied) {
    const ids = entry.ids.length === 1 ? `Model call ${entry.ids[0]} was` : `Model calls ${entry.ids.join(", ")} were`;
    notes.push(
      `${ids} attributed by order, between ${entry.with.length + 1} sessions that all sent ${JSON.stringify(excerptOf(text))} (this one and ${entry.with.join(", ")}): each went to the oldest unanswered message. Give each test's prompt something of its own, or have the agent send \`user\`.`,
    );
  }
  return notes;
}

/** Throw `ModelProblemError` when the subject's session has model problems. Nothing for a subject outside a session. */
async function failOnProblems(subject: unknown): Promise<void> {
  const handle = subject as Partial<InSession>;
  if (typeof handle[QUIET] !== "function") return;
  let problems: readonly string[] | undefined;
  try {
    problems = (await unreportedRefusals(() => (handle as InSession)[QUIET]())).problems;
  } catch (error) {
    if (error instanceof ChannelstackError) return;
    throw error;
  }
  if (problems !== undefined && problems.length > 0) throw new ModelProblemError(problems);
}

/**
 * What the agent has left open in the subject's session, in words. Nothing for a subject outside a
 * session, or where the server can't tell (live, without proxy mode): it only adds to a failure's
 * message, so its refusal must not turn the failure into a skip.
 */
async function stillOpen(subject: unknown): Promise<string[]> {
  const handle = subject as Partial<InSession>;
  if (typeof handle[QUIET] !== "function") return [];
  try {
    return (await unreportedRefusals(() => (handle as InSession)[QUIET]())).open;
  } catch (error) {
    if (error instanceof ChannelstackError) return [];
    throw error;
  }
}

/** The bot loops the fake stopped in the subject's session (decision 0027), in words. */
async function stoppedLoops(subject: unknown): Promise<string[]> {
  const handle = subject as Partial<InSession>;
  if (typeof handle[QUIET] !== "function") return [];
  try {
    return (await unreportedRefusals(() => (handle as InSession)[QUIET]())).loops ?? [];
  } catch (error) {
    if (error instanceof ChannelstackError) return [];
    throw error;
  }
}

const from = (author: AuthorRef, text?: string | RegExp) => (message: Message) =>
  fromMatches(message.author, author) && textMatches(message.text, text);

interface Activity {
  readonly type: string;
  readonly author: Author;
  readonly body?: string | undefined;
}

interface AgentSession {
  state(): Promise<string>;
  activities(): Promise<Activity[]>;
}

/** A Linear agent session, or the latest one of an issue (the subject a session matcher was given). */
async function sessionOf(subject: unknown): Promise<AgentSession | undefined> {
  const handle = subject as Partial<AgentSession> & { sessions?: () => Promise<AgentSession[]> };
  if (typeof handle.state === "function" && typeof handle.activities === "function") return handle as AgentSession;
  if (typeof handle.sessions === "function") return (await handle.sessions()).at(-1);
  throw new TypeError("This matcher needs an agent session or an issue");
}

/** A comment: GitHub and Linear call its text `body`, Notion calls it `text`. */
interface Comment {
  readonly author: Author;
  readonly body?: string;
  readonly text?: string;
}
const commentText = (comment: Comment) => comment.body ?? comment.text ?? "";

/** The text of each block of a Notion page, nested ones included: its rich text, or a child page's title. */
const blockTexts = (blocks: readonly unknown[]): string[] =>
  blocks.flatMap((raw) => {
    const block = raw as { type?: string; children?: unknown[] } & Record<string, unknown>;
    const data = (block.type ? block[block.type] : undefined) as
      { rich_text?: Array<{ plain_text?: string }>; title?: string } | undefined;
    const text = data?.rich_text ? data.rich_text.map((item) => item.plain_text ?? "").join("") : (data?.title ?? "");
    return [text, ...blockTexts(block.children ?? [])];
  });

interface ReviewComment extends Comment {
  readonly path: string;
  readonly line: number;
}

/**
 * The comments of a subject that has a conversation: a GitHub issue or pull request, a Linear
 * issue, a Notion discussion. A Notion page has none of its own: they are in its discussions.
 */
const commentsOf = (subject: unknown, matcher: string): Promise<readonly Comment[]> => {
  const handle = subject as { comments?: () => Promise<Comment[]>; discussions?: unknown };
  if (typeof handle.comments === "function") return handle.comments();
  throw new Error(
    typeof handle.discussions === "function"
      ? `${matcher} needs a Notion discussion, not a page: a page's comments are in its discussions. Pass \`comment.discussion\`, or one of \`await page.discussions()\`.`
      : `${matcher} needs a GitHub issue or pull request, a Linear issue or a Notion discussion`,
  );
};
const commentFrom = (author: AuthorRef, text?: string | RegExp) => (comment: Comment) =>
  fromMatches(comment.author, author) && textMatches(commentText(comment), text);
const written = (comments: readonly Comment[]) =>
  listing(comments.map((comment) => `${comment.author.name}: ${commentText(comment)}`));

/** Who wrote each message of a conversation, oldest first: its replies, its transcript, or its comments. */
async function writersOf(subject: unknown): Promise<readonly { name: string; app: boolean }[]> {
  const handle = subject as { replies?: unknown; transcript?: unknown; comments?: () => Promise<Comment[]> };
  const authors =
    typeof handle.replies === "function" || typeof handle.transcript === "function"
      ? (await messagesOf(subject)).map((message) => message.author)
      : typeof handle.comments === "function"
        ? (await handle.comments()).map((comment) => comment.author)
        : undefined;
  if (authors === undefined)
    throw new TypeError("toGoQuiet needs a thread, a conversation, or something with comments");
  return authors.map((author) => ({ name: author.name, app: (author as { kind?: string }).kind === "app" }));
}

/**
 * The app messages of a conversation since a person last wrote in it, those before a check began
 * included, and their authors in turn (`my-agent → coder → my-agent`): what `toGoQuiet` and each
 * `<channel>.no-reply-loop` name when apps answer each other (decision 0027).
 */
export async function appTurns(subject: unknown): Promise<{ count: number; turns: string }> {
  const writers = await writersOf(subject);
  const since = writers.slice(writers.findLastIndex((writer) => !writer.app) + 1);
  return { count: since.length, turns: since.map((writer) => writer.name).join(" → ") };
}

export const matchers = {
  /**
   * The conversation goes quiet within `within`, holding at most `maxReplies` app messages since
   * a person last wrote in it, those before the check began included: apps that answer each other
   * without end fail it (decision 0027).
   */
  async toGoQuiet(
    state: MatcherState,
    subject: unknown,
    options: { within?: Duration; maxReplies: number; quietFor?: Duration },
  ) {
    const handle = subject as Partial<InSession>;
    if (typeof handle[QUIET] !== "function") throw new TypeError("This matcher needs a channelstack handle");
    const within = options.within ?? state.timeout;
    let quiet = true;
    try {
      await untilQuiet(() => (handle as InSession)[QUIET](), {
        timeout: within,
        quietFor: options.quietFor ?? state.quietFor,
        watching: true,
      });
    } catch (error) {
      if (!(error instanceof WaitTimeoutError)) throw error;
      quiet = false;
    }
    const since = await appTurns(subject);
    const pass = quiet && since.count <= options.maxReplies;
    const turns = since.count === 0 ? "" : `: ${since.turns}`;
    const open = pass === state.isNot ? await stillOpen(subject) : [];
    const loops = pass === state.isNot ? await stoppedLoops(subject) : [];
    return {
      pass,
      message: () =>
        `Expected the conversation ${state.isNot ? "not " : ""}to go quiet within ${typeof within === "number" ? `${within}ms` : within} with at most ${options.maxReplies} app ${options.maxReplies === 1 ? "message" : "messages"} since a person last wrote. ${
          quiet ? "It went quiet" : "It was still busy"
        } with ${since.count} app ${since.count === 1 ? "message" : "messages"} and no person between them${turns}${
          open.length === 0 ? "" : `\nStill open: ${open.join("; ")}`
        }${loops.length === 0 ? "" : `\nStopped: ${loops.join("; ")}`}`,
    };
  },

  /** The thread (or DM) has at least one reply from this author. */
  toHaveReplyFrom(
    state: MatcherState,
    subject: unknown,
    author: AuthorRef,
    options?: Timing & { text?: string | RegExp },
  ) {
    const wanted = `a reply from ${nameOf(author)}${options?.text === undefined ? "" : ` matching ${show(options.text)}`}`;
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => messagesOf(subject),
      holds: (messages) => messages.some(from(author, options?.text)),
      describe: (messages) =>
        `Expected ${state.isNot ? wanted.replace(/^a /, "no ") : wanted}. The thread has:\n${says(messages)}`,
    });
  },

  /** Exactly `count` replies from this author, checked once the agent is quiet. */
  toHaveRepliesFrom(
    state: MatcherState,
    subject: unknown,
    author: AuthorRef,
    options: Timing & { count: number; text?: string | RegExp },
  ) {
    return settle(subject, state, options, {
      onceQuiet: true,
      read: async () => (await messagesOf(subject)).filter(from(author, options.text)),
      holds: (replies) => replies.length === options.count,
      describe: (replies) =>
        `Expected ${state.isNot ? "not " : ""}exactly ${options.count} ${options.count === 1 ? "reply" : "replies"} from ${nameOf(author)}, found ${replies.length}:\n${says(replies)}`,
    });
  },

  /** A message from this author directly in the channel, outside any thread. */
  toHaveChannelMessageFrom(state: MatcherState, subject: unknown, author: AuthorRef, options?: Timing) {
    return settle(subject, state, options, {
      onceQuiet: false,
      read: async () => (await (subject as { messages(): Promise<Message[]> }).messages()).filter(from(author)),
      holds: (messages) => messages.length > 0,
      describe: (messages) =>
        state.isNot
          ? `Expected no message from ${nameOf(author)} in the channel itself, found:\n${says(messages)}`
          : `Expected a message from ${nameOf(author)} in the channel itself, found none`,
    });
  },

  /** Some entry a person would see contains this text. `count` makes it exact. */
  toContainText(
    state: MatcherState,
    subject: unknown,
    text: string | RegExp,
    options?: Timing & { count?: number; from?: AuthorRef; as?: Viewer },
  ) {
    const read = async () => {
      const transcript = await (subject as HasTranscript).transcript(options?.as ? { as: options.as } : {});
      const entries = transcript.entries.filter(
        (entry) => options?.from === undefined || fromMatches(entry.author, options.from),
      );
      return { entries, matching: entries.filter((entry) => textMatches(entry.text, text)) };
    };
    return settle(subject, state, options, {
      onceQuiet: options?.count !== undefined,
      read,
      holds: ({ matching }) => (options?.count === undefined ? matching.length > 0 : matching.length === options.count),
      describe: ({ entries, matching }) =>
        `Expected ${state.isNot ? "no text" : options?.count === undefined ? "text" : `exactly ${options.count} entries with text`} matching ${show(text)}, found ${matching.length}. A person sees:\n${listing(entries.map((entry) => `${entry.author.name}: ${entry.text}`))}`,
    });
  },

  /** A reply from this author is being streamed right now. */
  toHaveStreamingReplyFrom(state: MatcherState, subject: unknown, author?: AuthorRef, options?: Timing) {
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => messagesOf(subject),
      holds: (messages) =>
        messages.some(
          (message) =>
            message.stream?.state === "open" && (author === undefined || fromMatches(message.author, author)),
        ),
      describe: (messages) =>
        `Expected ${state.isNot ? "no" : "a"} reply being streamed${author === undefined ? "" : ` by ${nameOf(author)}`}. The thread has:\n${listing(messages.map((message) => `${message.author.name}: ${message.text} [${message.stream?.state ?? "not a stream"}]`))}`,
    });
  },

  /** The agent's state in this thread: `working`, `streaming`, `stopped` or `idle`. */
  toHaveStatus(
    state: MatcherState,
    subject: unknown,
    expected: "working" | "streaming" | "stopped" | "idle",
    options?: Timing,
  ) {
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => (subject as { status(): Promise<{ state: string; text?: string }> }).status(),
      holds: (status) => status.state === expected,
      describe: (status) =>
        `Expected the thread ${state.isNot ? "not " : ""}to be ${expected}, it is ${status.state}${status.text ? ` ("${status.text}")` : ""}`,
    });
  },

  /** The status line the agent set. */
  toHaveStatusText(state: MatcherState, subject: unknown, text: string | RegExp, options?: Timing) {
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => (subject as { status(): Promise<{ state: string; text?: string }> }).status(),
      holds: (status) => status.text !== undefined && textMatches(status.text, text),
      describe: (status) =>
        `Expected the status line ${state.isNot ? "not " : ""}to match ${show(text)}, ${status.text === undefined ? "there is none" : `it is "${status.text}"`}`,
    });
  },

  /** The message has a button with this label; for a thread or a conversation, the agent's latest message there. */
  toHaveButton(state: MatcherState, subject: unknown, label: string | RegExp, options?: Timing) {
    const handle = subject as { thread?: HasTranscript; ts?: string; id?: string } & Partial<HasTranscript>;
    return settle(subject, state, options, {
      onceQuiet: false,
      read: async () => {
        // A Slack message (it has a thread and a `ts`) is one entry of its thread's transcript.
        if (handle.thread && handle.ts !== undefined) {
          const { entries } = await handle.thread.transcript();
          return entries.filter((entry) => entry.id === handle.ts).flatMap((entry) => entry.controls);
        }
        // A message whose own transcript starts with it (Discord's), or the app's latest message in a thread or channel.
        const { entries } = await (handle as HasTranscript).transcript();
        const own = handle.id === undefined ? undefined : entries.find((entry) => entry.id === handle.id);
        return (own ?? entries.filter((entry) => entry.author.kind === "app").at(-1))?.controls ?? [];
      },
      holds: (controls) => controls.some((control) => textMatches(control, label)),
      describe: (controls) =>
        `Expected ${state.isNot ? "no" : "a"} button matching ${show(label)}. Buttons there: ${controls.length === 0 ? "none" : controls.join(", ")}`,
    });
  },

  toHaveReaction(state: MatcherState, subject: unknown, emoji: string, options?: Timing & { by?: AuthorRef }) {
    const name = emoji.replace(/^:|:$/g, "");
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => (subject as { reactions(): Promise<Array<{ emoji: string; by: Author[] }>> }).reactions(),
      holds: (reactions) =>
        reactions.some(
          (reaction) =>
            reaction.emoji === name &&
            (options?.by === undefined || reaction.by.some((author) => fromMatches(author, options.by))),
        ),
      describe: (reactions) =>
        `Expected ${state.isNot ? "no" : "a"} :${name}: reaction${options?.by === undefined ? "" : ` by ${nameOf(options.by)}`}. Reactions there: ${reactions.length === 0 ? "none" : reactions.map((reaction) => `:${reaction.emoji}: by ${reaction.by.map((author) => author.name).join(", ")}`).join("; ")}`,
    });
  },

  /** Subject: a person. The agent opened a modal for them (it may be submitted by now), with this title if one is given. */
  toHaveOpenedModal(state: MatcherState, subject: unknown, title?: string | RegExp, options?: Timing) {
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => (subject as { modals(): Promise<Array<{ title: string }>> }).modals(),
      holds: (modals) => modals.some((modal) => textMatches(modal.title, title)),
      describe: (modals) =>
        `Expected ${state.isNot ? "no" : "a"} modal${title === undefined ? "" : ` titled ${show(title)}`} to have been opened. Opened: ${modals.length === 0 ? "none" : modals.map((modal) => JSON.stringify(modal.title)).join(", ")}`,
    });
  },

  /** Subject: a GitHub issue or pull request, a Linear issue or a Notion discussion. At least one comment from this author. */
  toHaveCommentFrom(
    state: MatcherState,
    subject: unknown,
    author: AuthorRef,
    options?: Timing & { text?: string | RegExp },
  ) {
    const wanted = `a comment from ${nameOf(author)}${options?.text === undefined ? "" : ` matching ${show(options.text)}`}`;
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => commentsOf(subject, "toHaveCommentFrom"),
      holds: (comments) => comments.some(commentFrom(author, options?.text)),
      describe: (comments) =>
        `Expected ${state.isNot ? wanted.replace(/^a /, "no ") : wanted}. The conversation has:\n${written(comments)}`,
    });
  },

  /** Exactly `count` comments from this author, checked once the agent is quiet. */
  toHaveCommentsFrom(state: MatcherState, subject: unknown, author: AuthorRef, options: Timing & { count: number }) {
    return settle(subject, state, options, {
      onceQuiet: true,
      read: () => commentsOf(subject, "toHaveCommentsFrom"),
      holds: (comments) => comments.filter(commentFrom(author)).length === options.count,
      describe: (comments) =>
        `Expected ${state.isNot ? "not " : ""}exactly ${options.count} comments from ${nameOf(author)}, found ${comments.filter(commentFrom(author)).length}:\n${written(comments)}`,
    });
  },

  /** Subject: a pull request. A comment on the diff, matched by every field that is given. */
  toHaveReviewComment(
    state: MatcherState,
    subject: unknown,
    expected: { path?: string; line?: number; from?: AuthorRef; text?: string | RegExp },
    options?: Timing,
  ) {
    const pull = subject as { reviewComments(): Promise<ReviewComment[]> };
    const wanted = [
      expected.path === undefined
        ? ""
        : ` on ${expected.path}${expected.line === undefined ? "" : `:${expected.line}`}`,
      expected.from === undefined ? "" : ` from ${nameOf(expected.from)}`,
      expected.text === undefined ? "" : ` matching ${show(expected.text)}`,
    ].join("");
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => pull.reviewComments(),
      holds: (comments) =>
        comments.some(
          (comment) =>
            (expected.path === undefined || comment.path === expected.path) &&
            (expected.line === undefined || comment.line === expected.line) &&
            (expected.from === undefined || fromMatches(comment.author, expected.from)) &&
            textMatches(commentText(comment), expected.text),
        ),
      describe: (comments) =>
        `Expected ${state.isNot ? "no" : "a"} comment on the diff${wanted}. The diff has:\n${listing(comments.map((comment) => `${comment.author.name} on ${comment.path}:${comment.line}: ${comment.body}`))}`,
    });
  },

  /** Subject: a pull request. A review from this author, with this verdict if one is given. */
  toHaveReviewFrom(state: MatcherState, subject: unknown, author: AuthorRef, options?: Timing & { state?: string }) {
    const pull = subject as { reviews(): Promise<Array<{ author: Author; state: string; body: string }>> };
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => pull.reviews(),
      holds: (reviews) =>
        reviews.some(
          (review) =>
            fromMatches(review.author, author) && (options?.state === undefined || review.state === options.state),
        ),
      describe: (reviews) =>
        `Expected ${state.isNot ? "no" : "a"} review from ${nameOf(author)}${options?.state === undefined ? "" : ` with state ${options.state}`}. Reviews there:\n${listing(reviews.map((review) => `${review.author.name}: ${review.state}${review.body === "" ? "" : ` ${JSON.stringify(review.body)}`}`))}`,
    });
  },

  /** Subject: a pull request or a commit. A check run of this name, in this state if one is given. */
  toHaveCheckRun(
    state: MatcherState,
    subject: unknown,
    name: string | RegExp,
    options?: Timing & { status?: string; conclusion?: string },
  ) {
    const target = subject as {
      checkRuns(): Promise<Array<{ name: string; status: string; conclusion?: string | undefined }>>;
    };
    const wanted = [options?.status, options?.conclusion].filter((part) => part !== undefined).join(", ");
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => target.checkRuns(),
      holds: (runs) =>
        runs.some(
          (run) =>
            (typeof name === "string" ? run.name === name : textMatches(run.name, name)) &&
            (options?.status === undefined || run.status === options.status) &&
            (options?.conclusion === undefined || run.conclusion === options.conclusion),
        ),
      describe: (runs) =>
        `Expected ${state.isNot ? "no" : "a"} check run ${show(name)}${wanted === "" ? "" : ` (${wanted})`}. Check runs there:\n${listing(runs.map((run) => `${run.name}: ${run.status}${run.conclusion === undefined ? "" : `, ${run.conclusion}`}`))}`,
    });
  },

  /** Subject: an issue or a pull request. It has this label. */
  toHaveLabel(state: MatcherState, subject: unknown, name: string, options?: Timing) {
    const issue = subject as { labels(): Promise<string[]> };
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => issue.labels(),
      holds: (labels) => labels.some((label) => label.toLowerCase() === name.toLowerCase()),
      describe: (labels) =>
        `Expected ${state.isNot ? "no" : "the"} label ${JSON.stringify(name)}. Labels there: ${labels.length === 0 ? "none" : labels.join(", ")}`,
    });
  },

  /** Subject: a pull request. It has been merged. */
  toBeMerged(state: MatcherState, subject: unknown, options?: Timing) {
    const pull = subject as { merged(): Promise<boolean> };
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => pull.merged(),
      holds: (merged) => merged,
      describe: () => `Expected the pull request ${state.isNot ? "not " : ""}to be merged`,
    });
  },

  /** Subject: a Linear agent session, or an issue (its latest session). The session's status. */
  toHaveSessionState(state: MatcherState, subject: unknown, wanted: string, options?: Timing) {
    return settle(subject, state, options, {
      onceQuiet: false,
      read: async () => (await sessionOf(subject))?.state() ?? Promise.resolve("no session"),
      holds: (current) => current === wanted,
      describe: (current) => `Expected the agent session ${state.isNot ? "not " : ""}to be ${wanted}, it is ${current}`,
    });
  },

  /**
   * Subject: a Linear agent session, or an issue (its latest session). An activity of the agent's
   * matching every field that is given: a person's turns (`prompt`, delegating's first among them)
   * aren't what it published.
   */
  toHaveActivity(
    state: MatcherState,
    subject: unknown,
    expected: { type?: string; from?: AuthorRef; text?: string | RegExp },
    options?: Timing,
  ) {
    const wanted = [
      expected.type ?? "activity",
      expected.from === undefined ? "" : ` from ${nameOf(expected.from)}`,
      expected.text === undefined ? "" : ` matching ${show(expected.text)}`,
    ].join("");
    return settle(subject, state, options, {
      onceQuiet: false,
      read: async () =>
        ((await (await sessionOf(subject))?.activities()) ?? []).filter((activity) => activity.type !== "prompt"),
      holds: (activities) =>
        activities.some(
          (activity) =>
            (expected.type === undefined || activity.type === expected.type) &&
            (expected.from === undefined || fromMatches(activity.author, expected.from)) &&
            textMatches(activity.body ?? "", expected.text),
        ),
      describe: (activities) =>
        `Expected ${state.isNot ? "no" : "a"} ${wanted}. The session has:\n${listing(activities.map((activity) => `${activity.author.name} (${activity.type}): ${activity.body ?? ""}`))}`,
    });
  },

  /** Subject: a Linear issue. It is delegated to this app, or (with `undefined`) to none. */
  toBeDelegatedTo(state: MatcherState, subject: unknown, app: Author | undefined, options?: Timing) {
    const issue = subject as { delegatedTo(): Promise<Author | undefined> };
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => issue.delegatedTo(),
      holds: (delegate) => (app === undefined ? delegate === undefined : delegate?.id === app.id),
      describe: (delegate) =>
        `Expected the issue ${state.isNot ? "not " : ""}to be delegated to ${app?.name ?? "no one"}, it is delegated to ${delegate?.name ?? "no one"}`,
    });
  },

  /** Subject: a Linear issue. It is assigned to this person, or (with `undefined`) to no one. */
  toBeAssignedTo(state: MatcherState, subject: unknown, user: Author | undefined, options?: Timing) {
    const issue = subject as { assignee(): Promise<Author | undefined> };
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => issue.assignee(),
      holds: (assignee) => (user === undefined ? assignee === undefined : assignee?.id === user.id),
      describe: (assignee) =>
        `Expected the issue ${state.isNot ? "not " : ""}to be assigned to ${user?.name ?? "no one"}, it is assigned to ${assignee?.name ?? "no one"}`,
    });
  },

  /** Subject: a Notion page. A block (at any depth) whose text matches. */
  toHaveBlock(state: MatcherState, subject: unknown, text: string | RegExp, options?: Timing) {
    const page = subject as { blocks(): Promise<unknown[]> };
    return settle(subject, state, options, {
      onceQuiet: false,
      read: async () => blockTexts(await page.blocks()),
      holds: (texts) => texts.some((line) => textMatches(line, text)),
      describe: (texts) =>
        `Expected the page ${state.isNot ? "not " : ""}to have a block matching ${show(text)}. Its blocks:\n${listing(texts)}`,
    });
  },

  /** Subject: a Notion page. A property has this value; asymmetric matchers (`expect.any(Number)`) work. */
  toHavePropertyValue(state: MatcherState, subject: unknown, name: string, expected: unknown, options?: Timing) {
    const page = subject as { property(name: string): Promise<unknown> };
    const equals = state.equals ?? ((a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b));
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => page.property(name),
      holds: (value) => equals(value, expected),
      describe: (value) =>
        `Expected ${name} ${state.isNot ? "not " : ""}to be ${String(expected)}, it is ${JSON.stringify(value)}`,
    });
  },

  /** Subject: a Linear issue. Its workflow state, by name. */
  toHaveState(state: MatcherState, subject: unknown, name: string, options?: Timing) {
    const issue = subject as { state(): Promise<{ name: string }> };
    return settle(subject, state, options, {
      onceQuiet: false,
      read: async () => (await issue.state()).name,
      holds: (current) => current.toLowerCase() === name.toLowerCase(),
      describe: (current) =>
        `Expected the issue ${state.isNot ? "not " : ""}to be in ${JSON.stringify(name)}, it is in ${JSON.stringify(current)}`,
    });
  },

  /** Only this person can see the message. */
  async toBeEphemeralFor(
    state: MatcherState,
    subject: unknown,
    user: { readonly id: string; readonly name: string },
  ): Promise<MatcherResult> {
    const visibleTo = (subject as { visibleTo?: Author }).visibleTo;
    return {
      pass: visibleTo?.id === user.id,
      message: () =>
        `Expected the message ${state.isNot ? "not " : ""}to be visible only to ${user.name}, ${visibleTo === undefined ? "everyone can see it" : `only ${visibleTo.name} can`}`,
    };
  },

  /** The agent answered the delivery with 2xx, within the platform's window. */
  toBeAccepted(state: MatcherState, subject: unknown, options?: Timing & { within?: Duration }) {
    const delivery = subject as Delivery;
    const within = options?.within === undefined ? undefined : parseDuration(options.within);
    return settle(subject, state, options, {
      onceQuiet: false,
      read: async () => (await delivery.refresh()).attempts.find((attempt) => !attempt.forgedSignature),
      // Accepted, and with `within`, accepted that fast: the platform's window is only the outer limit.
      holds: (attempt) =>
        attempt?.status === "acknowledged" && (within === undefined || (attempt.durationMs ?? 0) <= within),
      describe: (attempt) => {
        const expected = `Expected delivery ${delivery.id} ${state.isNot ? "not " : ""}to be accepted${within === undefined ? "" : ` within ${within}ms`}`;
        const http = attempt?.responseStatus === undefined ? "" : ` (HTTP ${attempt.responseStatus})`;
        const took = attempt?.durationMs === undefined ? "" : ` after ${attempt.durationMs}ms`;
        return `${expected}, its first attempt is ${attempt?.status ?? "missing"}${http}${took}`;
      },
    });
  },

  /** A forged delivery (bad signature, stale timestamp) was refused by the agent with a 4xx. */
  toBeRejected(state: MatcherState, subject: unknown, options?: Timing) {
    const delivery = subject as Delivery;
    const refused = (attempt: Attempt | undefined) =>
      attempt?.status === "failed" &&
      attempt.responseStatus !== undefined &&
      attempt.responseStatus >= 400 &&
      attempt.responseStatus < 500;
    return settle(subject, state, options, {
      onceQuiet: false,
      read: async () => (await delivery.refresh()).attempts.filter((attempt) => attempt.forgedSignature).at(-1),
      holds: refused,
      describe: (attempt) =>
        attempt === undefined
          ? `Expected delivery ${delivery.id} to be rejected, but no forged attempt was sent. Call delivery.resend({ badSignature: true }) first`
          : `Expected the forged attempt of delivery ${delivery.id} ${state.isNot ? "not " : ""}to be rejected with a 4xx, the agent answered ${attempt.responseStatus ?? attempt.status}`,
    });
  },

  /** The delivery needed retries. */
  toBeRetried(state: MatcherState, subject: unknown, options?: Timing & { times?: number }) {
    const delivery = subject as Delivery;
    return settle(subject, state, options, {
      onceQuiet: options?.times !== undefined,
      read: async () => (await delivery.refresh()).attempts.filter((attempt) => !attempt.forgedSignature).length - 1,
      holds: (retries) => (options?.times === undefined ? retries > 0 : retries === options.times),
      describe: (retries) =>
        `Expected delivery ${delivery.id} ${state.isNot ? "not " : ""}to be retried${options?.times === undefined ? "" : ` ${options.times} times`}, it was retried ${retries} times`,
    });
  },

  /** The agent made this API call. */
  toHaveReceivedCall(
    state: MatcherState,
    subject: unknown,
    operation: string | RegExp,
    options?: Timing & { times?: number; error?: string },
  ) {
    // A channel's calls have an operation; a model call has its endpoint (`chat.completions`).
    const fixture = subject as {
      calls(options?: { error?: string }): Promise<Array<{ operation?: string; endpoint?: string; error?: string }>>;
    };
    const named = (call: { operation?: string; endpoint?: string }) => call.operation ?? call.endpoint ?? "";
    return settle(subject, state, options, {
      onceQuiet: options?.times !== undefined,
      read: async () => {
        const calls = await fixture.calls(options?.error === undefined ? {} : { error: options.error });
        return {
          calls,
          matching: calls.filter((call) =>
            typeof operation === "string" ? named(call) === operation : textMatches(named(call), operation),
          ),
        };
      },
      holds: ({ matching }) => (options?.times === undefined ? matching.length > 0 : matching.length === options.times),
      describe: ({ calls, matching }) =>
        `Expected the agent ${state.isNot ? "not " : ""}to call ${show(operation)}${options?.times === undefined ? "" : ` ${options.times} times`}${options?.error === undefined ? "" : ` with error ${options.error}`}, found ${matching.length}. Its calls:\n${listing(calls.map((call) => `${named(call)}${call.error ? ` → ${call.error}` : ""}`))}`,
    });
  },

  // --- The model (decision 0029) ---------------------------------------------------------------

  /**
   * What the agent sent the model: text, a pattern, a message's text, or several messages in order
   * (thread history). The subject is the `openai` fixture (any of the session's calls), a script
   * (the calls it answered), or one call.
   */
  toHaveSent(
    state: MatcherState,
    subject: unknown,
    expected: string | RegExp | Texted | readonly (string | Texted)[],
    options?: Timing & { ordered?: boolean },
  ) {
    const wanted = (Array.isArray(expected) ? expected : [expected]) as readonly (string | RegExp | Texted)[];
    const ordered = options?.ordered ?? Array.isArray(expected);
    return settle(subject, state, options, {
      onceQuiet: false,
      read: async () => (await modelCalls(subject)).map((call) => call.request.text),
      holds: (texts) => texts.some((text) => sentIn(text, wanted, ordered)),
      describe: (texts) =>
        `Expected the agent ${state.isNot ? "not " : ""}to send the model ${wanted.map((item) => show(asText(item))).join(", then ")}${ordered && wanted.length > 1 ? " in that order" : ""}. ${texts.length === 0 ? "It made no model call." : `What it sent, newest first:\n${listing(texts.toReversed().map((text) => excerptOf(text)))}`}`,
    });
  },

  /**
   * The agent sent the model this image, file or audio, compared by its SHA-256: a fixture file's
   * path (read as a `MediaSource` is, from the files root) or its bytes. The subject is the
   * `openai` fixture, a script or one call, as for `toHaveSent`.
   */
  toHaveSentFile(state: MatcherState, subject: unknown, file: string | Uint8Array, options?: Timing) {
    const read = readMedia(file);
    if (!("content" in read)) throw new TypeError("toHaveSentFile takes a path or bytes");
    const bytes = Buffer.from(read.content, "base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const named = read.name ?? "these bytes";
    return settle(subject, state, options, {
      onceQuiet: false,
      read: async () =>
        // A media endpoint's file is its message's first part, so the parts are everything.
        (await modelCalls(subject)).flatMap((call) =>
          (call.request.messages ?? []).flatMap((message) => message.parts ?? []),
        ),
      holds: (parts) => parts.some((part) => part.sha256 === sha256),
      describe: (parts) =>
        `Expected the agent ${state.isNot ? "not " : ""}to send the model ${named} (${sizeOf(bytes.length)}, sha256 ${sha256.slice(0, 12)}). ${parts.length === 0 ? "It sent no image, file or audio." : `What it sent, newest first:\n${listing(parts.toReversed().map(partOf))}`}`,
    });
  },

  /** A secret channelstack knows (a token, a signing secret, a key) was sent to the model. Use it as `not.`. */
  toHaveSentSecrets(state: MatcherState, subject: unknown, options?: Timing) {
    const fixture = subject as { sentSecrets(): Promise<ReadonlyArray<{ call: string; kinds: readonly string[] }>> };
    if (typeof fixture.sentSecrets !== "function") throw new TypeError("toHaveSentSecrets needs the openai fixture");
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => fixture.sentSecrets(),
      holds: (sent) => sent.length > 0,
      describe: (sent) =>
        sent.length === 0
          ? "Expected the agent to send the model a secret, it sent none"
          : `Expected the agent not to send the model any secret, it sent:\n${listing(sent.map((one) => `${one.call}: ${one.kinds.join(", ")}`))}`,
    });
  },

  /** The call offered the model this tool (with this JSON Schema). */
  toHaveOfferedTool(state: MatcherState, subject: unknown, name: string, options?: Timing & { schema?: unknown }) {
    return settle(subject, state, options, {
      onceQuiet: false,
      read: async () => (await modelCalls(subject)).flatMap((call) => call.request.tools),
      holds: (tools) =>
        tools.some(
          (tool) =>
            (tool.name ?? tool.type) === name &&
            (options?.schema === undefined || (state.equals ?? Object.is)(tool.parameters, options.schema)),
        ),
      describe: (tools) =>
        `Expected the agent ${state.isNot ? "not " : ""}to offer the model the tool ${JSON.stringify(name)}, it offered ${tools.length === 0 ? "none" : [...new Set(tools.map((tool) => tool.name ?? tool.type))].join(", ")}`,
    });
  },

  /** The agent ran the model's call to this tool and sent its result back (with this text). */
  toHaveSentToolResult(
    state: MatcherState,
    subject: unknown,
    name: string,
    options?: Timing & { text?: string | RegExp },
  ) {
    const handle = subject as { toolCalls(options?: { name?: string }): Promise<readonly ModelToolCall[]> };
    if (typeof handle.toolCalls !== "function")
      throw new TypeError("toHaveSentToolResult needs the openai fixture or a script");
    return settle(subject, state, options, {
      onceQuiet: false,
      read: () => handle.toolCalls({ name }),
      holds: (calls) => calls.some((call) => call.result !== undefined && textMatches(call.result.text, options?.text)),
      describe: (calls) =>
        `Expected the agent ${state.isNot ? "not " : ""}to send back a result for ${JSON.stringify(name)}${options?.text === undefined ? "" : ` with ${show(options.text)}`}. The model called it ${calls.length} times; ${calls.filter((call) => call.result).length} got a result${calls.some((call) => call.result) ? `:\n${listing(calls.flatMap((call) => (call.result ? [excerptOf(call.result.text)] : [])))}` : ""}`,
    });
  },

  /** The agent hung up before the model's answer was complete: it cancelled the request (Stop), or timed out. */
  toBeAborted(state: MatcherState, subject: unknown, options?: Timing) {
    const call = subject as { id: string; refresh(): Promise<{ response: { aborted: boolean; end?: string } }> };
    if (typeof call.refresh !== "function") throw new TypeError("toBeAborted needs a model call");
    return settle(subject, state, options, {
      onceQuiet: false,
      read: async () => (await call.refresh()).response,
      holds: (response) => response.aborted,
      describe: (response) =>
        `Expected model call ${call.id} ${state.isNot ? "not " : ""}to be aborted by the agent, it ${response.end === undefined ? "is still going" : `ended ${response.end}`}`,
    });
  },

  /**
   * The script answered calls (exactly `times` of them, once the agent is quiet): a call counts once
   * the script's turn reached the agent, not one it was given and the fake refused.
   */
  toHaveAnswered(state: MatcherState, subject: unknown, options?: Timing & { times?: number }) {
    const script = subject as {
      id: string;
      refresh(): Promise<{ problems: readonly string[] }>;
      calls(): Promise<readonly ScriptCall[]>;
    };
    if (typeof script.refresh !== "function" || typeof script.calls !== "function")
      throw new TypeError("toHaveAnswered needs a script");
    return settle(subject, state, options, {
      onceQuiet: options?.times !== undefined,
      read: async () => {
        const [calls, { problems }] = await Promise.all([script.calls(), script.refresh()]);
        return { answered: calls.filter(answered).length, problems };
      },
      holds: ({ answered: count }) => (options?.times === undefined ? count > 0 : count === options.times),
      describe: ({ answered: count, problems }) =>
        `Expected script ${script.id} ${state.isNot ? "not " : ""}to answer ${options?.times === undefined ? "a call" : `${options.times} ${options.times === 1 ? "call" : "calls"}`}, it answered ${count}${problems.length === 0 ? "" : `. Its problems:\n${listing(problems)}`}`,
    });
  },
};

/** Something with text: a channel's message, comment or email. */
interface Texted {
  readonly text: string;
}

/** A call a script was given, as far as its answer goes. */
interface ScriptCall {
  readonly response: {
    readonly status?: number | undefined;
    readonly text?: string | undefined;
    readonly error?: string | undefined;
  };
}

/**
 * Whether the script's turn reached the agent: an answer (text, tool calls, a refusal) or a
 * scripted error. Not a call the fake refused for the script (`channelstack_no_script`: a turn the
 * real API can't give, a list that ran out, a responder that threw), nor one a responder still
 * holds, nor one the agent hung up on before anything was sent (status 0 without a scripted error).
 */
const answered = ({ response }: ScriptCall) =>
  response.error !== "channelstack_no_script" &&
  (response.text !== undefined || response.error !== undefined) &&
  (response.status !== 0 || response.error !== undefined);

interface ModelToolCall {
  readonly name: string;
  readonly result?: { readonly text: string };
}

/** An image, file or audio in a model call, as the fake read it: no hash for a URL it didn't fetch. */
interface ModelPart {
  readonly type: string;
  readonly from: string;
  readonly url?: string;
  readonly fileId?: string;
  readonly mediaType?: string;
  readonly bytes?: number;
  readonly sha256?: string;
}

interface ModelCallData {
  readonly request: {
    readonly text: string;
    readonly tools: ReadonlyArray<{ readonly type: string; readonly name?: string; readonly parameters?: unknown }>;
    readonly messages?: ReadonlyArray<{ readonly parts?: readonly ModelPart[] }>;
  };
}

/** The model calls a matcher reads: the fixture's or a script's (a list), or one call. */
async function modelCalls(subject: unknown): Promise<readonly ModelCallData[]> {
  const handle = subject as {
    calls?: () => Promise<readonly ModelCallData[]>;
    request?: ModelCallData["request"];
    refresh?: () => Promise<ModelCallData>;
  };
  if (typeof handle.calls === "function") return handle.calls();
  if (typeof handle.refresh === "function") return [await handle.refresh()];
  if (handle.request !== undefined) return [handle as ModelCallData];
  throw new TypeError("This matcher needs the openai fixture, a script or a model call");
}

const asText = (item: string | RegExp | Texted): string | RegExp =>
  typeof item === "object" && "text" in item ? item.text : item;

/** Whether a request's text has every wanted piece, in order when asked. */
function sentIn(text: string, wanted: readonly (string | RegExp | Texted)[], ordered: boolean): boolean {
  const haystack = normalisedText(text);
  let from = 0;
  for (const item of wanted) {
    const piece = asText(item);
    if (piece instanceof RegExp) {
      piece.lastIndex = 0;
      const match = piece.exec(text);
      if (!match) return false;
      continue;
    }
    const needle = normalisedText(piece);
    const at = haystack.indexOf(needle, ordered ? from : 0);
    if (at === -1) return false;
    from = at + needle.length;
  }
  return true;
}

const sizeOf = (bytes: number) => `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;

/** One part as a failure lists it: its type, media type, size and hash, or where it is when the fake didn't read it. */
const partOf = (part: ModelPart) =>
  [
    part.type,
    part.mediaType,
    part.bytes === undefined ? undefined : sizeOf(part.bytes),
    part.sha256 === undefined
      ? (part.url ?? (part.fileId === undefined ? undefined : `file ${part.fileId}`))
      : `sha256 ${part.sha256.slice(0, 12)}`,
  ]
    .filter((piece) => piece !== undefined)
    .join(", ");

const excerptOf = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

export type MatcherName = keyof typeof matchers;
