/**
 * `channelstack/vitest`: Vitest plugin.
 *
 *   // vitest.config.ts
 *   import channelstack from "channelstack/vitest";
 *   export default defineConfig({ plugins: [channelstack()] });
 *
 * Adds a globalSetup (start or attach), a setup file that registers the matchers and
 * cleans up each test's resources, and these types.
 */
import type { Plugin } from "vite";
import type { SlackFixture } from "./slack";
import type { GitHubFixture } from "./github";
import type { LinearFixture } from "./linear";
import type { NotionFixture } from "./notion";
import type { ChannelstackFixture, ChannelstackIntegrationOptions } from "./server";
import type { ChannelstackMatchers } from "./matchers";

// `vitest` re-exports TestContext from `@vitest/runner`, so the fixtures are merged there.
declare module "@vitest/runner" {
  interface TestContext {
    channelstack: ChannelstackFixture;
    slack: SlackFixture;
    github: GitHubFixture;
    linear: LinearFixture;
    notion: NotionFixture;
  }
}

declare module "vitest" {
  // Vitest ≥ 3.2 merges custom matchers through `Matchers`.
  interface Matchers<T = any> extends ChannelstackMatchers<void> {}
}

export default function channelstack(options?: ChannelstackIntegrationOptions): Plugin;
