/**
 * `channelstack/jest`: Jest preset.
 *
 *   // jest.config.ts
 *   export default { preset: "channelstack/jest" };
 *
 * Jest has no per-test context object, so the fixtures are globals that are reset
 * for each test: `slack`, `github`, `linear`, `notion`, `channelstack`.
 */
import type { SlackFixture } from "./slack";
import type { GitHubFixture } from "./github";
import type { LinearFixture } from "./linear";
import type { NotionFixture } from "./notion";
import type { ChannelstackFixture, ChannelstackIntegrationOptions } from "./server";
import type { ChannelstackMatchers } from "./matchers";

declare global {
  var channelstack: ChannelstackFixture;
  var slack: SlackFixture;
  var github: GitHubFixture;
  var linear: LinearFixture;
  var notion: NotionFixture;

  namespace jest {
    interface Matchers<R> extends ChannelstackMatchers<R> {}
  }
}

/** Use from `jest.config.ts` when not using the preset: `globalSetup: channelstackGlobalSetup(...)`. */
export declare function channelstackGlobalSetup(options?: ChannelstackIntegrationOptions): () => Promise<void>;
