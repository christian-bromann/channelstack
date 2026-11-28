import { TEXT_NORMALISATION } from "../generated/normalisation.ts";
import { type Duration, parseDuration } from "./duration.ts";

export interface WaitOptions {
  /** Give up after this long. Default: 10s, or what `setWaitDefaults` set. */
  timeout?: Duration;
  /** How often to read. Default: 50ms. */
  interval?: Duration;
}

/** What every wait uses when it isn't given a `timeout` or `quietFor`. */
export interface WaitDefaults {
  timeout: Duration;
  quietFor: Duration;
}

const defaults: WaitDefaults = { timeout: "10s", quietFor: "750ms" };

/**
 * Change the default `timeout` and `quietFor` of every wait: `waitFor…`, `latest…`, the reads that
 * wait for quiet, and calls repeated while refused. The Vitest plugin sets them from its `timeout`
 * and `quietFor` options. What isn't given stays as it is.
 */
export function setWaitDefaults(options: Partial<WaitDefaults>): void {
  for (const key of ["timeout", "quietFor"] as const) {
    const value = options[key];
    if (value === undefined) continue;
    parseDuration(value);
    defaults[key] = value;
  }
}

/** The defaults every wait uses now (a copy). */
export function waitDefaults(): WaitDefaults {
  return { ...defaults };
}

export class WaitTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    this.name = "WaitTimeoutError";
  }
}

/**
 * The one polling loop: read until `read` returns something other than undefined, or the
 * timeout passes. Every `waitFor…`, `latest…` and matcher is built on it; tests never sleep.
 */
export async function waitFor<T>(
  what: string | (() => string),
  read: () => Promise<T | undefined>,
  options: WaitOptions = {},
): Promise<T> {
  const timeout = parseDuration(options.timeout ?? defaults.timeout);
  const interval = parseDuration(options.interval ?? "50ms");
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() + interval > deadline) throw new WaitTimeoutError(typeof what === "string" ? what : what(), timeout);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * Repeat a call while it is refused with one of these error codes, the way a person waits for a
 * button to appear before clicking it. When the time is up, the last refusal is the error.
 */
export async function retryWhile<T>(
  codes: readonly string[],
  call: () => Promise<T>,
  options: WaitOptions = {},
): Promise<T> {
  let refusal: unknown;
  try {
    return await waitFor(
      "the call to be accepted",
      async () => {
        try {
          return { value: await call() };
        } catch (error) {
          if (!codes.includes(String((error as { code?: unknown } | null)?.code))) throw error;
          refusal = error;
          return undefined;
        }
      },
      options,
    ).then(({ value }) => value);
  } catch (error) {
    throw error instanceof WaitTimeoutError && refusal !== undefined ? refusal : error;
  }
}

export interface QuietOptions extends WaitOptions {
  /**
   * How long the agent must be quiet (no call in flight, no delivery in flight or about to be retried, no open stream)
   * before the result is read. Default: 750ms, or what `setWaitDefaults` set.
   */
  quietFor?: Duration;
}

/** What the server says about the agent's activity in a session (`GET /sessions/{sid}/quiet`). */
export interface QuietState {
  busy: boolean;
  quietForMs: number;
  /** What is still open, in words: a delivery in flight or about to be retried, a stream the agent never stopped. */
  open: string[];
  /** What should fail a test at once: a model call no script answered (decision 0029). */
  problems?: string[];
  /** The bot loops the fake stopped in the session (decision 0027), when there are any. */
  loops?: string[];
}

/** A wait that stopped because the session's model calls went wrong: no script answered one, a script ran out. */
export class ModelProblemError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`The model calls of this test went wrong:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
    this.name = "ModelProblemError";
    this.problems = problems;
  }
}

/** Anyone who can author something: a handle with an id and a name. */
interface Author {
  readonly id: string;
  readonly name: string;
}

/** Does an item's author match a `from` filter: a handle, a name, or nothing (anyone)? */
export function fromMatches(author: Author, from: Author | string | undefined): boolean {
  if (from === undefined) return true;
  return typeof from === "string" ? author.name === from || author.id === from : author.id === from.id;
}

/** Does a text match what was asked for: a string it contains, a pattern, or nothing (any text)? */
export function textMatches(text: string, expected: string | RegExp | undefined): boolean {
  if (expected === undefined) return true;
  if (typeof expected === "string") return text.includes(expected);
  // A pattern with the `g` or `y` flag remembers where it stopped; every test starts afresh.
  expected.lastIndex = 0;
  return expected.test(text);
}

const NORMALISATION_RULES = TEXT_NORMALISATION.rules.map(
  ({ pattern, replacement }) => [new RegExp(pattern, "g"), replacement] as const,
);

/**
 * Text as the server compares it for attribution, by the rules the spec publishes
 * (`TEXT_NORMALISATION`, generated): what `toHaveSent` compares.
 */
export function normalisedText(text: string): string {
  let normalised = NORMALISATION_RULES.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text,
  );
  if (TEXT_NORMALISATION.collapseWhitespace) normalised = normalised.replace(/\s+/g, " ").trim();
  return TEXT_NORMALISATION.lowercase ? normalised.toLowerCase() : normalised;
}

/** Text to find as it goes to the server: a string as it is, a `RegExp` as its source and flags. */
export function patternOnWire(pattern: string | RegExp): string | { source: string; flags: string } {
  return typeof pattern === "string" ? pattern : { source: pattern.source, flags: pattern.flags };
}

/** "a reply" → "a reply from my-agent", for timeout messages. */
export function describeWait(what: string, from: Author | string | undefined): string {
  return from === undefined ? what : `${what} from ${typeof from === "string" ? from : from.name}`;
}

/**
 * Wait for the next new item of a list that matches, after the last one this handle returned.
 * `seen` belongs to the handle and remembers, per wait, how far it has looked. With `startsTurn`,
 * the wait also looks only after the newest item that starts a turn (a person's prompt).
 */
export function waitForNext<T>(
  seen: Map<string, number>,
  key: string,
  read: () => Promise<readonly T[]>,
  matches: (item: T) => boolean,
  what: string,
  options: WaitOptions = {},
  startsTurn?: (item: T) => boolean,
): Promise<T> {
  return waitFor(
    what,
    async () => {
      const items = await read();
      const turn = startsTurn ? items.findLastIndex(startsTurn) + 1 : 0;
      const from = Math.max(seen.get(key) ?? 0, turn);
      const index = items.findIndex((item, position) => position >= from && matches(item));
      if (index === -1) return undefined;
      seen.set(key, index + 1);
      return items[index];
    },
    options,
  );
}

/**
 * Resolve once the agent has been quiet for `quietFor`. Negative and exact-count checks read after this.
 *
 * With `watching`, the quiet time counts from now at the earliest: the caller wants to have looked
 * for the whole window. An agent that is thinking makes no sound, so a session that went quiet a
 * while ago says nothing about what arrives next.
 */
export async function untilQuiet(
  quiet: () => Promise<QuietState>,
  options: QuietOptions & { watching?: boolean } = {},
): Promise<void> {
  const quietFor = parseDuration(options.quietFor ?? defaults.quietFor);
  const started = Date.now();
  let open: string[] = [];
  await waitFor(
    // A wait that gives up says what the agent left open: that is usually the bug.
    () => `the agent to be quiet for ${quietFor}ms${open.length > 0 ? `. Still open: ${open.join("; ")}` : ""}`,
    async () => {
      const state = await quiet();
      open = state.open;
      if (state.problems !== undefined && state.problems.length > 0) throw new ModelProblemError(state.problems);
      if (options.watching && Date.now() - started < quietFor) return undefined;
      return !state.busy && state.quietForMs >= quietFor ? true : undefined;
    },
    options,
  );
}

/** The last item of a list that matches, read once the agent is quiet. Waits for at least one first. */
export async function latestOnceQuiet<T>(
  read: () => Promise<readonly T[]>,
  matches: (item: T) => boolean,
  quiet: () => Promise<QuietState>,
  what: string,
  options: QuietOptions = {},
): Promise<T> {
  const latest = async () => (await read()).filter(matches).at(-1);
  await waitFor(what, latest, options);
  await untilQuiet(quiet, options);
  // The agent may have said more while it was settling: the answer is what is there now.
  return waitFor(what, latest, options);
}
