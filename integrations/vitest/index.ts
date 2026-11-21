/**
 * `channelstack/vitest`: the Vitest plugin.
 *
 *   // vitest.config.ts
 *   import channelstack from "channelstack/vitest";
 *   export default defineConfig({ plugins: [channelstack()] });
 *
 * It adds a global setup (attach to a running server, or start one), a setup file that gives
 * every test its own session and fixtures and registers the matchers, and the types below.
 */
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Duration, GitHubFixture, SlackFixture } from "../../sdks/typescript/client.ts";
import type { MatcherName, matchers } from "../matchers-core/index.ts";

export interface ChannelstackIntegrationOptions {
  /** Attach to this server instead of the one in `server.json`. Also `CHANNELSTACK_URL`. */
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
}

/** The `channelstack` fixture: the server itself, across all channels. */
export interface ChannelstackFixture {
  /** Control API and UI base, e.g. `https://channelstack.localhost`. */
  readonly url: string;
  /** Env vars for the agent: tokens, secrets and API URLs (what `channelstack env` prints). */
  env(): Promise<Record<string, string>>;
  /** Resolve when the agent is quiet in this test's session. */
  quiet(options?: { quietFor?: Duration; timeout?: Duration }): Promise<void>;
  /** Drop all state on every channel. Avoid in parallel suites. */
  reset(): Promise<void>;
}

/** Each matcher's arguments after the subject, as `expect(subject).<matcher>(...)` takes them. */
type MatcherArguments<Name extends MatcherName> = (typeof matchers)[Name] extends (
  state: never,
  subject: never,
  ...rest: infer Rest
) => unknown
  ? Rest
  : never;

type ChannelstackMatchers = { [Name in MatcherName]: (...args: MatcherArguments<Name>) => Promise<void> };

declare module "vitest" {
  interface TestContext {
    channelstack: ChannelstackFixture;
    slack: SlackFixture;
    github: GitHubFixture;
  }

  // The type parameters have to be Vitest 5's own for this to merge with its declaration.
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> extends ChannelstackMatchers {}

  interface ProvidedContext {
    /** Where the test workers find the server the global setup attached to or started. */
    channelstack: { url: string; token: string; timeout: Duration; quietFor: Duration };
  }
}

/** The environment variable the plugin hands its options to the global setup in. */
export const OPTIONS_ENV = "CHANNELSTACK_VITEST_OPTIONS";

const sibling = (name: string) => fileURLToPath(new URL(`./${name}${extname(import.meta.url)}`, import.meta.url));

/** The Vitest plugin. */
export default function channelstack(options: ChannelstackIntegrationOptions = {}) {
  return {
    name: "channelstack",
    config(config: { test?: { setupFiles?: string | string[] } }) {
      // The plugin's setup comes before the project's own setup files: its `beforeEach` (the
      // fixtures) runs first and its `afterEach` (closing the session) last, so a project's own
      // hooks can still use the fixtures.
      config.test ??= {};
      config.test.setupFiles = [sibling("setup"), ...[config.test.setupFiles ?? []].flat()];
      return { test: { globalSetup: [sibling("global-setup")], env: { [OPTIONS_ENV]: JSON.stringify(options) } } };
    },
  };
}
