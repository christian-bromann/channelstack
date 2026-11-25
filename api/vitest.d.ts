/**
 * `channelstack/vitest`: Vitest plugin.
 *
 *   // vitest.config.ts
 *   import channelstack from "channelstack/vitest";
 *   export default defineConfig({ plugins: [channelstack()] });
 *
 * Adds a globalSetup (start or attach), a setup file that registers the matchers and
 * cleans up each test's resources, and these types. A project without a `testTimeout` gets
 * one above the checks' own wait (30s, or three times `timeout`); a project's own always wins.
 */
import type { Plugin } from "vite";
import type { SlackFixture } from "./slack";
import type { GitHubFixture } from "./github";
import type { LinearFixture } from "./linear";
import type { NotionFixture } from "./notion";
import type { ChannelstackFixture, ChannelstackIntegrationOptions } from "./server";
import type { ChannelstackMatchers } from "./matchers";

// Vitest 5 reads custom fixtures from `TestContext` and custom matchers from `Matchers`, both in `vitest`.
declare module "vitest" {
  interface TestContext {
    channelstack: ChannelstackFixture;
    slack: SlackFixture;
    github: GitHubFixture;
    linear: LinearFixture;
    notion: NotionFixture;
  }

  // Vitest 5 declares `Matchers<R, T>`; the parameters have to be identical to merge with it.
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> extends ChannelstackMatchers<void> {}
}

export default function channelstack(options?: ChannelstackIntegrationOptions): Plugin;
