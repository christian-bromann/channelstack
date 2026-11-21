/**
 * Shared types for every channelstack channel.
 *
 * Conventions used across all channels:
 * - Every action is a method on the person who takes it. The content comes first and
 *   where it happens is an option named after the resource:
 *   `ana.say("…", { channel })`, `ana.comment("…", { issue: pr })`, `ana.stop({ session })`.
 *   Resources (channels, threads, PRs, sessions, pages) are only read and waited on.
 * - System-level actions with no person behind them live on the fixture or the
 *   delivery: `slack.createChannel(...)`, `delivery.retry()`, `delivery.redeliver()`.
 * - Every action resolves to what it created (a message, comment, session, delivery).
 * - Text inputs are `RichText`: `@name` becomes a real mention of that user or app on the
 *   platform (`<@U…>` in Slack, `@login` on GitHub, a mention node in Linear and Notion).
 *   Write `@@` for a literal `@`.
 * - Created resources implement `AsyncDisposable`. Fixtures clean up at the end of each
 *   test, so `await using` is only needed outside fixtures. Disposing never asserts.
 */

/** A duration: milliseconds as a number, or `"250ms"`, `"3s"`, `"1m"`. */
export type Duration = number | `${number}ms` | `${number}s` | `${number}m`;

/** ISO 8601 timestamp string. */
export type Timestamp = string;

export type ChannelKind = "slack" | "github" | "linear" | "notion";

/** Text that may contain `@name` mentions. */
export type RichText = string;

export interface WaitOptions {
  /** Give up after this long. Default: 10s (configurable per test framework integration). */
  timeout?: Duration;
}

export interface QuietOptions extends WaitOptions {
  /**
   * For negative and exact-count checks: how long the agent must be quiet (no open
   * stream, no API call in flight) before the check is evaluated. Default: 750ms.
   */
  quietFor?: Duration;
}

/** Base for every person or app that can act or author content. */
export interface Principal {
  readonly channel: ChannelKind;
  /** The platform's own id, in its real format (Slack `U08B5K2M9QX`, a Linear or Notion UUID, a GitHub numeric id as a string), in fake mode too. */
  readonly id: string;
  readonly name: string;
}

/** A person. Created per test with `<channel>.createUser(...)`. */
export interface User extends Principal {
  readonly kind: "user";
}

/** The agent's app on a channel, as described in `channelstack.config.ts`. One per channel. */
export interface App extends Principal {
  readonly kind: "app";
  /** The app's bot or actor user id on the platform (Slack `U…`, GitHub `<slug>[bot]` id). */
  readonly botUserId: string;
}

/** Anything that can be named as an author in a matcher: a handle or its `name`. */
export type AuthorRef = Principal | string;

/** Something channelstack created for a test. */
export interface Resource extends AsyncDisposable {
  readonly channel: ChannelKind;
  /** The platform's own id, in its real format (`C08E1F2G3H4`, a Linear or Notion UUID, …), in fake mode too. */
  readonly id: string;
  /** Link to this resource in the channelstack UI. */
  readonly uiUrl: string;
}

// ---------------------------------------------------------------------------
// Deliveries: what channelstack sends to the agent
// ---------------------------------------------------------------------------

export type DeliveryStatus =
  /** Queued or in flight. */
  | "pending"
  /** The agent answered 2xx in time. */
  | "acknowledged"
  /** The agent answered, but not 2xx. */
  | "failed"
  /** The agent didn't answer within the platform's ack window (Slack: 3s). */
  | "timed_out"
  /** The agent's endpoint couldn't be reached. */
  | "unreachable";

export type DeliveryTransport = "http" | "socket";

export interface DeliveryAttempt {
  readonly number: number;
  readonly sentAt: Timestamp;
  readonly transport: DeliveryTransport;
  readonly url?: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly status: DeliveryStatus;
  readonly responseStatus?: number;
  readonly responseBody?: string;
  readonly durationMs?: number;
  /** True when this attempt was sent with a deliberately wrong signature. */
  readonly forgedSignature: boolean;
}

export interface ResendOptions {
  /** Sign with the wrong secret. The agent should reject it. */
  badSignature?: boolean;
  /** Send with a timestamp outside the platform's replay window. */
  stale?: boolean;
  /** Override or add headers for this attempt. */
  headers?: Record<string, string>;
}

/** An event, interaction or webhook channelstack sent to the agent, with every attempt. */
export interface Delivery<TType extends string = string, TPayload = unknown> {
  readonly id: string;
  readonly channel: ChannelKind;
  /** Platform event type, e.g. `app_mention`, `issue_comment`, `AgentSessionEvent`. */
  readonly type: TType;
  readonly payload: TPayload;
  readonly attempts: readonly DeliveryAttempt[];
  /** Status of the latest attempt. */
  readonly status: DeliveryStatus;

  /** Wait until the latest attempt reaches a final status. Resolves with the delivery, read again. */
  settled(options?: WaitOptions): Promise<this>;

  /** Send the same delivery again, unchanged or with a twist (bad signature, stale timestamp). */
  resend(options?: ResendOptions): Promise<DeliveryAttempt>;
}

export interface DeliveryFilter {
  type?: string | RegExp;
  status?: DeliveryStatus | DeliveryStatus[];
  since?: Timestamp;
  /** Only deliveries caused by actions on this resource. */
  resource?: Resource;
}

// ---------------------------------------------------------------------------
// API calls: what the agent sent to channelstack
// ---------------------------------------------------------------------------

export interface ApiCall {
  readonly id: string;
  readonly channel: ChannelKind;
  /** Platform-level name: `chat.postMessage`, `POST /repos/{owner}/{repo}/issues/{n}/comments`, `agentActivityCreate`. */
  readonly operation: string;
  readonly method: string;
  readonly path: string;
  readonly at: Timestamp;
  readonly durationMs: number;
  readonly request: unknown;
  readonly responseStatus: number;
  readonly response: unknown;
  /** The platform error code channelstack returned, e.g. `not_in_channel`, `missing_scope`. */
  readonly error?: string;
  /** The app identity the call authenticated as. */
  readonly app?: App;
}

export interface ApiCallFilter {
  operation?: string | RegExp;
  /** Only calls that returned a platform error (optionally a specific one). */
  error?: true | string;
  since?: Timestamp;
}

/** Inspection helpers every channel fixture has. `calls` and `waitForCall` see the agent's API calls: fake mode, or live with proxy mode. */
export interface Inspectable<TDelivery extends Delivery = Delivery> {
  deliveries(filter?: DeliveryFilter): Promise<TDelivery[]>;
  calls(filter?: ApiCallFilter): Promise<ApiCall[]>;
  /** Wait for the next API call matching the filter. Fake mode, or live when the agent runs in proxy mode. */
  waitForCall(filter: ApiCallFilter, options?: WaitOptions): Promise<ApiCall>;
}

// ---------------------------------------------------------------------------
// Transcript: what a person would read
// ---------------------------------------------------------------------------

/**
 * A resource reduced to what a person would read: edits applied, deletes removed,
 * stream chunks joined, ephemeral content only for its recipient, block and button
 * text extracted. The UI and every text matcher (`toContainText`, `toHaveReplyFrom`, …) read this same view.
 */
export interface Transcript {
  readonly entries: readonly TranscriptEntry[];
  /** Plain-text rendering, one entry per line block. Handy for snapshots. */
  toString(): string;
}

export interface TranscriptEntry {
  readonly id: string;
  readonly author: Principal;
  readonly at: Timestamp;
  readonly text: string;
  /** Labels of interactive elements in this entry (buttons, select options). */
  readonly controls: readonly string[];
  readonly edited: boolean;
  /** For streamed content. */
  readonly streaming?: "open" | "stopped" | "completed";
  /** For ephemeral content: the only person who can see it. */
  readonly visibleTo?: Principal;
  /** Nesting depth: 0 for top level, 1 for a reply in a thread or discussion. */
  readonly depth: number;
}

export interface HasTranscript {
  transcript(options?: { as?: Principal }): Promise<Transcript>;
}

/** Files in a test: inline contents, or a path to a fixture file or directory. */
export type FileInput =
  | { name: string; content: string | Uint8Array; mimeType?: string }
  | { path: string; name?: string };
