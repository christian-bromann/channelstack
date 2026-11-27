import type { Hono } from "hono";

import type { Attribution, Attributor } from "../attribution/index.ts";
import type { BrowserActors } from "../browser/index.ts";
import type { Clock, Timers } from "../clock/index.ts";
import type { DeliveryQueue } from "../delivery/index.ts";
import type { DevAdapter } from "../dev/index.ts";
import type { EventLog } from "../events/index.ts";
import type { IdFormat, IdGenerator } from "../ids/index.ts";
import type { Ledger, LedgerEntry } from "../ledger/index.ts";
import type { Logger } from "../log/index.ts";
import type { Registry } from "../registry/index.ts";
import type { Allowlist } from "../safety/index.ts";
import type { LiveVault, SecretFormat, SecretSpec } from "../secrets/index.ts";
import type { DriverRouter } from "./route.ts";

/**
 * A fake platform: the provider API the agent calls, over an in-memory store.
 * Design and rationale: docs/decisions/0001-fake-backend.md.
 */
export interface FakeBackend {
  /** The provider API emulation, served at the driver's host (`<name>.localhost`) or path prefix (`/<name>`). */
  readonly api: Hono;
  /** Seed the world-level objects that exist before any session: the workspace and the agent's app. Also re-seeds after a reset. */
  seed(): void;
  /** Remove what a closed session owned from the store's own indexes. The registry drops the objects themselves. */
  release(session: string): void;
  /**
   * A WebSocket the agent wants to open to this fake (Slack's Socket Mode). Returns what handles
   * the connection, or nothing when the fake doesn't expect one there.
   */
  socket?(request: Request): SocketSession | undefined;
}

/** One WebSocket connection from the agent, as the fake sees it. The server feeds it what happens. */
export interface SocketSession {
  /** The connection is up; `peer` is how to talk back. */
  open(peer: SocketPeer): void;
  message(text: string): void;
  closed(): void;
}

/** The agent's end of a WebSocket connection. */
export interface SocketPeer {
  send(text: string): void;
  close(): void;
}

/** Per action: does it work in the fake, does it work live, and what does live need. */
export type CapabilityTable = Readonly<Record<string, { fake: boolean; live: boolean; liveRequires: string[] }>>;

/**
 * What a driver needs to act on its real platform (live-mode.md). Every driver gets it; only a
 * driver whose credentials are set ever uses it.
 */
export interface LiveContext {
  /** Every credential the driver declares is set and `CHANNELSTACK_REALITY` isn't `fake`: the driver acts on its real platform. */
  readonly active: boolean;
  /** `CHANNELSTACK_REALITY=live`: nothing may fall back to fake, not even a person without a token. */
  readonly strict: boolean;
  /** The app's credentials from the server's environment, and the people's as tests hand them over. */
  readonly vault: LiveVault;
  /** The driver's `CHANNELSTACK_LIVE_*` allowlist. */
  readonly allowlist: Allowlist;
  /** Where everything created live is recorded, so its session (or `channelstack sweep`) removes it. */
  readonly ledger: Ledger;
  /** The tag live objects carry in their names: `channelstack-run-<run>`. */
  readonly tag: string;
  readonly fetch: typeof fetch;
  /** The browser actors of the open sessions: a person's browser, for what only the platform's client does. */
  readonly browsers: BrowserActors;
  /** The state directory, where `channelstack login` saved people's browser sessions. */
  readonly home: string | undefined;
  /**
   * The platform's API base URL, for unit tests that stand a stub in for the platform. Set only
   * through `createApp`, never from the environment, so a credential can't be sent elsewhere.
   */
  readonly apiBase: string | undefined;
}

/** A driver's way onto its real platform. */
interface LiveBackend {
  /** The check before the first live action: the app's credentials work and its workspace is allowlisted. Runs once; a failure is kept. */
  ready(): Promise<void>;
  /** Forget what a closed session made live. The ledger has removed it from the platform already. */
  release(session: string): void;
}

/** What makes a driver live: every one of `credentials` set in the server's environment. */
interface LiveDeclaration {
  /** Environment variables, all of which make the driver live (`CHANNELSTACK_SLACK_APP_ID`, …). */
  readonly credentials: readonly string[];
  /** The allowlist variable (`CHANNELSTACK_LIVE_SLACK_TEAMS`). */
  readonly allowlist: string;
  /** `channelstack doctor` and `channelstack sweep`, for a driver whose live backend is built. */
  readonly maintenance?: LiveMaintenance;
}

/** One line of `channelstack doctor`. Its text names variables and token prefixes, never a credential. */
export interface LiveCheck {
  readonly ok: boolean;
  readonly text: string;
}

/** What a sweep removed, and what is still there (with why). */
export interface SweepReport {
  removed: string[];
  left: string[];
  /** The ledger entries it removed, so their files can forget them. */
  done: LedgerEntry[];
}

/** Where a person signs in to a platform by hand, once, for `channelstack login`, and when they are in. */
interface LiveSignIn {
  /** The page sign-in starts at. */
  start: string;
  /** The origins the browser may open. */
  origins: readonly string[];
  /** The person is signed in once the browser is at a URL like this. */
  signedIn(url: string): boolean;
  /** The sites whose cookies are the session. */
  cookieDomains: readonly string[];
}

/** What the command line runs for a live driver, outside any server, from the credentials in the environment. */
export interface LiveMaintenance {
  doctor(input: MaintenanceInput): Promise<LiveCheck[]>;
  /** For `channelstack login`: where the browser actor's sign-in happens. A driver without it has nothing to sign in to. */
  signIn?(input: MaintenanceInput): Promise<LiveSignIn>;
  /**
   * Remove what crashed runs left: the ledger's entries, and tagged objects older than `olderThanMs`
   * (any age for one `run`). With `check`, only report what is still there.
   */
  sweep(
    input: MaintenanceInput & {
      entries: readonly LedgerEntry[];
      check: boolean;
      run: string | undefined;
      olderThanMs: number;
      now: number;
    },
  ): Promise<SweepReport>;
}

interface MaintenanceInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  readonly timers: Timers;
  /** For unit tests only: a stand-in for the platform. */
  readonly apiBase?: string;
}

/** What core hands a driver. A driver never reaches past this into core, and never into another driver. */
export interface DriverContext {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** For anything that happens later: a retry after a pause, a fault's latency. */
  readonly timers: Timers;
  readonly registry: Registry;
  readonly events: EventLog;
  /** The hook into the delivery queue: the only way an event reaches the agent. */
  readonly delivery: DeliveryQueue;
  readonly log: Logger;
  /** Tell the quiet detector that the agent will do this again within this time: it was told to retry later. */
  expectMore(session: string, what: string, withinMs: number): void;
  /** The agent did it again: the quiet detector stops waiting for it. */
  arrived(session: string, what: string): void;
  /** One of the secrets the driver declared in `secrets`. */
  secret(name: string): string;
  /** Where the agent reaches this driver's fake, e.g. `https://echo.localhost`. */
  apiUrl(): string;
  /** Where the agent receives this driver's events, if it has an endpoint. */
  readonly webhookUrl: string | undefined;
  readonly live: LiveContext;
  /** For a provider: which session a request that names none belongs to (core/attribution). */
  readonly attribution: Attributor;
  /** For a provider: where an attributed request belongs in the channels, from the delivery that decided it. */
  place(attribution: Attribution | undefined): MessagePlace;
  /** The kinds of secret channelstack knows that are in this text (`slack.botToken`), never their values. */
  findSecrets(text: string): string[];
  /** A value with every token and registered secret scrubbed, as the event log records it. */
  scrub<T>(value: T): T;
}

/** Where a message is on its channel, by the platform's ids: who wrote it, the conversation, the thread, the message. */
export interface MessagePlace {
  readonly channel?: string;
  readonly from?: string;
  readonly conversation?: string;
  readonly thread?: string;
  readonly message?: string;
}

export interface Driver {
  readonly name: string;
  /** Control API routes and schemas: the source of the SDK surface. */
  routes(router: DriverRouter): void;
  readonly fake: FakeBackend;
  /** The live backend, for a driver that has one. Without it the driver is fake only, credentials or not. */
  readonly live?: LiveBackend;
  capabilities(): CapabilityTable;
  /** What `channelstack env` prints for this channel. */
  env(): Record<string, string>;
  /**
   * What of the agent's work in a session is still open, in words a failure message can show:
   * a stream it hasn't stopped, for example. Empty when nothing is.
   */
  openWork(session: string): string[];
  /**
   * What went wrong in a session that should fail its test at once, in words: a model call no
   * script answered (a provider's). Waiting matchers fail on these instead of timing out.
   */
  problems?(session: string): string[];
}

/** How a driver registers itself with core: its name, the secrets it needs, and how to build it. */
export interface DriverDefinition {
  readonly name: string;
  /** The platform's name as people write it (`GitHub`), and the prefix of its types in the SDKs (`GitHubUser`). */
  readonly title: string;
  /** channelstack's own test platform (`echo`): in the binary, but not a channel anyone tests against. */
  readonly internal?: boolean;
  /**
   * A fake the agent calls that has no people, apps or deliveries: the fake OpenAI (decision 0029).
   * It has a fixture, but it isn't a channel.
   */
  readonly provider?: boolean;
  /** Where the message a delivery tells the agent about is, by the platform's ids: what a provider's calls are about. */
  place?(body: string): Omit<MessagePlace, "channel"> | undefined;
  /**
   * How the dev tools (the attach CLI, `channelstack mcp`, the UI) act on the channel by names and
   * `last` (`core/dev`). Every channel has one; `pnpm check:channels` holds them to it.
   */
  readonly dev?: DevAdapter;
  /**
   * The last path segment that sends a delivery again (`/deliveries/{delivery}/<this>`), in the
   * platform's own word: Slack retries. Defaults to `redeliver`.
   */
  readonly redeliver?: string;
  /** Every kind of id the driver generates (`idFormats`): exit check 0.5 holds each one to its format. */
  readonly ids: Readonly<Record<string, IdFormat>>;
  /**
   * The shapes of the platform's tokens, fake or real (`/xox[abeoprs]-…/g`, global): the redactor
   * scrubs them from logs, errors and the event log. A signing secret with no shape is scrubbed
   * by its value instead, once the secrets are loaded.
   */
  readonly tokenPatterns: readonly RegExp[];
  /**
   * Tokens the platform issues that aren't among `secrets`: ones the fake never generates (a
   * person's Slack token, a Linear API key), or makes per request (Google's access tokens). The
   * redaction tests make one of each and check `tokenPatterns` scrubs it.
   */
  readonly liveTokens?: readonly SecretFormat[];
  readonly secrets: SecretSpec;
  /** What makes it live. A driver without it is always fake. */
  readonly live?: LiveDeclaration;
  /**
   * The provider hosts proxy mode routes to this fake (`slack.com`), first the one its API is at.
   * They are what channelstack's CA may vouch for, and nothing else.
   */
  readonly hosts?: readonly string[];
  /**
   * Paths the platform's SDK puts at the root of whatever host it is given, dropping a path the
   * base URL has (`googleapis`: `/gmail/v1/`). Without portless, where each fake is under a path
   * prefix, the server serves these at its root too, so the SDK finds them.
   */
  readonly rootPaths?: readonly string[];
  create(context: DriverContext): Driver;
}
