/**
 * `channelstack/client`: the generated client the test integrations are built on.
 * Experimental until the integrations ship (phase 1); the public contract is `api/*.d.ts`.
 */
export * from "./generated/index.ts";
export { type Duration, parseDuration } from "./runtime/duration.ts";
export { type InSession, QUIET } from "./runtime/client.ts";
export type { LaunchOptions } from "./runtime/launcher.ts";
export { ChannelstackError } from "./runtime/transport.ts";
export {
  fromMatches,
  type QuietOptions,
  type QuietState,
  untilQuiet,
  type WaitOptions,
  WaitTimeoutError,
  waitFor,
} from "./runtime/wait.ts";
