import type { Hono } from "hono";

import type { Clock, Timers } from "../clock/index.ts";
import type { DeliveryQueue } from "../delivery/index.ts";
import type { EventLog } from "../events/index.ts";
import type { IdGenerator } from "../ids/index.ts";
import type { Logger } from "../log/index.ts";
import type { Registry } from "../registry/index.ts";
import type { SecretSpec } from "../secrets/index.ts";
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
}

/** Per action: does it work in the fake, does it work live, and what does live need. */
export type CapabilityTable = Readonly<Record<string, { fake: boolean; live: boolean; liveRequires: string[] }>>;

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
}

export interface Driver {
  readonly name: string;
  /** Control API routes and schemas: the source of the SDK surface. */
  routes(router: DriverRouter): void;
  readonly fake: FakeBackend;
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
  create(context: DriverContext): Driver;
}
