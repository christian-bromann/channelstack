/**
 * `channelstack` and `channelstack/client`: the generated client the test integrations are built
 * on, and its types (`import type { SlackUser } from "channelstack"`).
 */
export { CHANNEL_NAMES, type ChannelFixtures, PROVIDER_NAMES, type ProviderFixtures } from "./generated/channels.ts";
export * from "./generated/index.ts";
export { type Duration, parseDuration } from "./runtime/duration.ts";
export { type FileInput, setFilesRoot } from "./runtime/files.ts";
export { type InSession, QUIET } from "./runtime/client.ts";
export type { Responder } from "./runtime/responder.ts";
export type { LaunchOptions } from "./runtime/launcher.ts";
export { ChannelstackError, onRefusal, unreportedRefusals } from "./runtime/transport.ts";
export type * from "./types.ts";
export {
  fromMatches,
  ModelProblemError,
  type QuietOptions,
  type QuietState,
  setWaitDefaults,
  textMatches,
  untilQuiet,
  type WaitDefaults,
  type WaitOptions,
  WaitTimeoutError,
  waitDefaults,
  waitFor,
} from "./runtime/wait.ts";
