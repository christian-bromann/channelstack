import type { Duration } from "./common";

/** The `channelstack` fixture: the server itself, across all channels. */
export interface ChannelstackFixture {
  /** Control API and UI base, e.g. `https://channelstack.localhost`. */
  readonly url: string;
  /** Env vars for the agent: tokens, secrets and API URLs (what `channelstack env` prints). */
  env(): Promise<Record<string, string>>;
  /** Resolve when the agent is quiet: no open stream, no call in flight, for `quietFor`. */
  quiet(options?: { quietFor?: Duration; timeout?: Duration }): Promise<void>;
  /** Drop all state on every channel. Avoid in parallel suites; prefer fresh resources per test. */
  reset(): Promise<void>;
}

/** Options shared by every test-framework integration. */
export interface ChannelstackIntegrationOptions {
  /** Attach to this server instead of looking it up through portless. Also `CHANNELSTACK_URL`. */
  server?: string;
  /**
   * `auto` (default): attach if a server is running, otherwise start one for the run.
   * `attach`: fail if none is running. `start`: always start a private one.
   */
  mode?: "auto" | "attach" | "start";
  /**
   * Default timeout for matchers and every SDK wait (`waitFor…`, `latest…`, `settled`). Default "10s".
   * A project without its own `testTimeout` gets one above it: 30s, or three times this.
   */
  timeout?: Duration;
  /** Default quiet window for negative and exact-count matchers and `latest…` reads. Default "750ms". */
  quietFor?: Duration;
}
