/**
 * `channelstack/checks`: the standard behaviour checks. Each call registers ordinary tests
 * in the current Vitest suite.
 */
import type { Duration } from "./common";

export interface ChecksOptions {
  /** The agent's app name: `my-agent`, the fakes' built-in app. */
  app: string;
  /** Text that makes the agent reply, e.g. "@my-agent hello". Default: `@<app> hello`. */
  prompt?: string;
  /**
   * Text that makes the agent stream a longer answer in a DM. Without it the stream and Stop
   * checks are left out: not every agent streams.
   */
  streamPrompt?: string;
  /**
   * Text that makes the agent ask for an approval, and the label of the button it shows. A
   * workspace admin may press it; anyone else may not. Without it the click checks are left out.
   *
   * `slack.double-click` counts messages: it expects the agent to answer one approval with exactly
   * one new message in the thread (it may also replace the question). An agent that answers only
   * in place, or with several messages, skips that check.
   */
  approval?: { prompt: string; button: string };
  /** Skip checks by id, e.g. `["slack.stream-stop"]` for an agent that doesn't stream. */
  skip?: string[];
  timeout?: Duration;
}

/**
 * Registers: replies once to a DM · once to a mention · replies in the thread · survives
 * Slack's 3s retry · handles redelivery idempotently · ignores its own and other bots'
 * messages · rejects a bad signature · acks within 3s · handles `msg_too_long` · a stream
 * starts and stops · honours Stop · refuses clicks from people who may not act · a double
 * click acts once.
 */
export declare function slackChecks(options: ChecksOptions): void;

/**
 * Registers: ignores its own comments · one comment per trigger · review-thread replies
 * trigger it · redelivery doesn't duplicate · check runs reach a conclusion · rejects a
 * bad webhook signature.
 */
export declare function githubChecks(options: ChecksOptions): void;

/**
 * Registers: a mention opens one session · delegation opens one session · a prompt gets
 * one response · Stop ends the session · the session never stays `active` after the work
 * is done · redelivery doesn't duplicate activities.
 */
export declare function linearChecks(options: ChecksOptions): void;

/**
 * Registers: replies once to a comment mention · replies in the same discussion · ignores
 * its own comments · stays silent on pages it isn't connected to.
 */
export declare function notionChecks(options: ChecksOptions): void;

/**
 * Registers: answers an email in its thread · a webhook sent again doesn't answer twice ·
 * rejects a bad webhook signature · rejects a stale webhook.
 */
export declare function resendChecks(options: ChecksOptions): void;
