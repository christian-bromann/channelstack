/**
 * The channel matchers, independent of any test framework. Each one reads plain SDK methods and
 * returns whether it passed and what to say if not; `integrations/vitest` (and later Jest) only
 * adapt them to their `expect`.
 *
 * - A positive matcher polls until its condition holds, or fails after the timeout.
 * - A negated matcher, and one with an exact count, waits until the agent is quiet and checks once.
 */
import {
  type Duration,
  fromMatches,
  type InSession,
  parseDuration,
  QUIET,
  type SlackConversation,
  textMatches,
  untilQuiet,
  waitFor,
  WaitTimeoutError,
} from "../../sdks/typescript/client.ts";

export interface MatcherResult {
  pass: boolean;
  /** Why it failed (or, for a negated matcher, why it unexpectedly passed). */
  message: () => string;
}

export interface MatcherState {
  /** True under `.not`. */
  isNot: boolean;
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

/** Who a transcript is read as: the SDK's own type, so a change to that signature fails to compile here. */
type Viewer = NonNullable<NonNullable<Parameters<SlackConversation["transcript"]>[0]>["as"]>;

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
    await untilQuiet(() => (handle as InSession)[QUIET](), {
      timeout,
      quietFor: timing?.quietFor ?? state.quietFor,
      watching: true,
    });
    value = await options.read();
  } else {
    let last: T | undefined;
    try {
      value = await waitFor(
        "the condition",
        async () => {
          last = await options.read();
          return options.holds(last) ? last : undefined;
        },
        { timeout },
      );
    } catch (error) {
      if (!(error instanceof WaitTimeoutError)) throw error;
      value = last as T;
    }
  }
  const pass = options.holds(value);
  // A failed check also says what the agent left open (a stream it never stopped): often that is the bug.
  const open = pass === state.isNot ? await stillOpen(subject) : [];
  const leftover = open.length === 0 ? "" : `\nStill open: ${open.join("; ")}`;
  return { pass, message: () => `${options.describe(value)}${leftover}` };
}

/** What the agent has left open in the subject's session, in words. Nothing for a subject outside a session. */
async function stillOpen(subject: unknown): Promise<string[]> {
  const handle = subject as Partial<InSession>;
  return typeof handle[QUIET] === "function" ? (await (handle as InSession)[QUIET]()).open : [];
}

const from = (author: AuthorRef, text?: string | RegExp) => (message: Message) =>
  fromMatches(message.author, author) && textMatches(message.text, text);

export const matchers = {
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
    const handle = subject as { thread?: HasTranscript; ts?: string } & Partial<HasTranscript>;
    return settle(subject, state, options, {
      onceQuiet: false,
      read: async () => {
        // A message (it has a thread) is one entry of its thread's transcript.
        if (handle.thread) {
          const { entries } = await handle.thread.transcript();
          return entries.filter((entry) => entry.id === handle.ts).flatMap((entry) => entry.controls);
        }
        const { entries } = await (handle as HasTranscript).transcript();
        return entries.filter((entry) => entry.author.kind === "app").at(-1)?.controls ?? [];
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
    const fixture = subject as {
      calls(options?: { error?: string }): Promise<Array<{ operation: string; error?: string }>>;
    };
    return settle(subject, state, options, {
      onceQuiet: options?.times !== undefined,
      read: async () => {
        const calls = await fixture.calls(options?.error === undefined ? {} : { error: options.error });
        return {
          calls,
          matching: calls.filter((call) =>
            typeof operation === "string" ? call.operation === operation : textMatches(call.operation, operation),
          ),
        };
      },
      holds: ({ matching }) => (options?.times === undefined ? matching.length > 0 : matching.length === options.times),
      describe: ({ calls, matching }) =>
        `Expected the agent ${state.isNot ? "not " : ""}to call ${show(operation)}${options?.times === undefined ? "" : ` ${options.times} times`}${options?.error === undefined ? "" : ` with error ${options.error}`}, found ${matching.length}. Its calls:\n${listing(calls.map((call) => `${call.operation}${call.error ? ` → ${call.error}` : ""}`))}`,
    });
  },
};

export type MatcherName = keyof typeof matchers;
