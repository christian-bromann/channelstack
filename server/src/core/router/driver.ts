import type { Hono } from "hono";

import type { Clock, Timers } from "../clock/index.ts";
import type { DeliveryQueue } from "../delivery/index.ts";
import type { EventLog } from "../events/index.ts";
import type { IdGenerator } from "../ids/index.ts";
import type { Ledger, LedgerEntry } from "../ledger/index.ts";
import type { Logger } from "../log/index.ts";
import type { Registry } from "../registry/index.ts";
import type { Allowlist } from "../safety/index.ts";
import type { LiveVault, SecretSpec } from "../secrets/index.ts";
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

/** What the command line runs for a live driver, outside any server, from the credentials in the environment. */
export interface LiveMaintenance {
  doctor(input: MaintenanceInput): Promise<LiveCheck[]>;
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
}

/** How a driver registers itself with core: its name, the secrets it needs, and how to build it. */
export interface DriverDefinition {
  readonly name: string;
  readonly secrets: SecretSpec;
  /** What makes it live. A driver without it is always fake. */
  readonly live?: LiveDeclaration;
  create(context: DriverContext): Driver;
}
