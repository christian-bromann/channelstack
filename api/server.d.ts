import type { ApiCall, ApiCallFilter, Delivery, DeliveryFilter, Duration } from "./common";

/** The `channelstack` fixture: the server itself, across all channels. */
export interface ChannelstackFixture {
  /** Control API and UI base, e.g. `https://channelstack.localhost`. */
  readonly url: string;
  /**
   * Env vars for the agent: tokens, secrets, API URLs, CA settings (what `channelstack env` prints).
   * With `proxy`, for an agent with hard-coded hosts: the proxy and the CA it trusts instead of the
   * API URLs (`channelstack env --proxy`; the server must run with `--proxy`).
   */
  env(options?: { proxy?: boolean }): Promise<Record<string, string>>;
  deliveries(filter?: DeliveryFilter): Promise<Delivery[]>;
  calls(filter?: ApiCallFilter): Promise<ApiCall[]>;
  /** Resolve when the agent is quiet: no open stream, no call in flight, for `quietFor`. */
  quiet(options?: { quietFor?: Duration; timeout?: Duration }): Promise<void>;
  /** Drop all state on every channel. Avoid in parallel suites; prefer fresh resources per test. */
  reset(): Promise<void>;
}

/** Options shared by every test-framework integration. */
export interface ChannelstackIntegrationOptions {
  /** Path to `channelstack.config.ts`. Default: found from the project root. */
  config?: string;
  /** Attach to this server instead of looking it up through portless. Also `CHANNELSTACK_URL`. */
  server?: string;
  /**
   * `auto` (default): attach if a server is running, otherwise start one for the run.
   * `attach`: fail if none is running. `start`: always start a private one.
   */
  mode?: "auto" | "attach" | "start";
  /** Default matcher and wait timeout. Default "10s". */
  timeout?: Duration;
  /** Default quiet window for negative and exact-count matchers. Default "750ms". */
  quietFor?: Duration;
  /** Which channel fixtures to inject. Default: every channel configured. */
  channels?: Array<"slack" | "github" | "linear" | "notion">;
}
