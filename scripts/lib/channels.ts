/**
 * What the acceptance, conformance and live scripts know about each channel, in one place: its
 * examples and what of them is enabled, its reference agents, and its agent with one fault per
 * standard check. Every script reads its channels from here, so a new channel is one entry.
 * `pnpm check:channels` holds this table to the drivers' list of channels.
 */

export interface ChannelHarness {
  /**
   * What is enabled of `test/acceptance/examples/<channel>.test.ts` (docs/phases.md), as patterns on Vitest's
   * full test names ("describe > test"): whole `describe` blocks, and single tests of blocks a later
   * phase completes.
   */
  readonly enabled: readonly string[];
  /** Tests besides the examples that need a server and the channel's reference agent. */
  readonly suites: readonly string[];
  /**
   * The reference agents (`examples/agents/<name>`), and where each takes webhooks. The first is
   * the channel's reference: the conformance run, `shared.test.ts` and the nightly live run use it.
   */
  readonly agents: Readonly<Record<string, string>>;
  /** The agent with one fault per standard check (`BROKEN=<check id>`), and where it takes webhooks. */
  readonly broken: { readonly agent: string; readonly path: string };
}

export const HARNESS = {
  slack: {
    enabled: [
      "mentions and threads > ",
      "direct messages > ",
      "buttons, menus, modals and commands > ",
      "streaming, status and Stop > ",
      "reactions, edits and deletes > ",
      "inspecting what the agent did > ",
      // Everything but the Socket Mode test, which needs an agent started in Socket Mode (exit check 2.2).
      "delivery and failures \\(fake only\\) > (?!reconnects after the Socket Mode)",
      // The same agent again, as the app `coder` (exit check 12.2).
      "several apps > ",
    ],
    // Quiet and parallel sessions (not examples), and the standard checks as a developer adds them (exit check 2.3).
    suites: [
      "test/acceptance/stack",
      "test/acceptance/checks/slack-checks.test.ts",
      // The checks against the second app, `coder` (exit check 12.7).
      "test/acceptance/checks/slack-checks-coder.test.ts",
    ],
    agents: { "bolt-ai-sdk": "/slack/events", "chat-sdk-slack": "/slack/events" },
    broken: { agent: "broken-slack", path: "/slack/events" },
  },
  github: {
    enabled: [
      "issues > ",
      "pull requests and reviews > ",
      "pushes and check runs > ",
      "delivery and failures \\(fake only\\) > ",
      "inspecting what the agent did > ",
      // The same agent again, as the App `coder` (exit check 12.2).
      "several apps > ",
    ],
    // The standard checks as a developer adds them (exit check 3.4).
    suites: [
      "test/acceptance/checks/github-checks.test.ts",
      // The checks against the second App, `coder` (exit check 12.7).
      "test/acceptance/checks/github-checks-coder.test.ts",
    ],
    agents: { probot: "/api/github/webhooks", "chat-sdk-github": "/api/webhooks/github" },
    broken: { agent: "broken-github", path: "/api/webhooks/github" },
  },
  linear: {
    enabled: [
      "delegation and agent sessions > ",
      "conversation inside a session > ",
      "issue workflow > ",
      "delivery and failures \\(fake only\\) > ",
      "inspecting what the agent did > ",
      // The same agent again, as the app `coder` (exit check 12.2).
      "several apps > ",
    ],
    // The standard checks as a developer adds them (exit check 4.5).
    suites: [
      "test/acceptance/checks/linear-checks.test.ts",
      // The checks against the second app, `coder` (exit check 12.7).
      "test/acceptance/checks/linear-checks-coder.test.ts",
    ],
    agents: { "linear-sdk": "/webhooks/linear", "chat-sdk-linear": "/api/webhooks/linear" },
    broken: { agent: "broken-linear", path: "/webhooks/linear" },
  },
  notion: {
    enabled: [
      "comments and discussions > ",
      "connections > ",
      "pages and databases > ",
      "delivery and failures \\(fake only\\) > ",
      // The same agent again, as the app `coder` (exit check 12.2).
      "several apps > ",
    ],
    suites: [
      "test/acceptance/checks/notion-checks.test.ts",
      // The checks against the second app, `coder` (exit check 12.7).
      "test/acceptance/checks/notion-checks-coder.test.ts",
    ],
    agents: { "notion-sdk": "/webhooks/notion" },
    broken: { agent: "broken-notion", path: "/webhooks/notion" },
  },
  resend: {
    enabled: ["email conversations > ", "delivery and failures \\(fake only\\) > ", "inspecting what the agent did > "],
    // The standard checks as a developer adds them (exit check 8.5).
    suites: ["test/acceptance/checks/resend-checks.test.ts"],
    agents: { "resend-node": "/webhooks/resend" },
    broken: { agent: "broken-resend", path: "/webhooks/resend" },
  },
  google: {
    enabled: ["email conversations > ", "delivery and failures \\(fake only\\) > ", "inspecting what the agent did > "],
    // The standard checks as a developer adds them (exit check 9.4).
    suites: ["test/acceptance/checks/google-checks.test.ts"],
    agents: { "gmail-node": "/webhooks/google" },
    broken: { agent: "broken-google", path: "/webhooks/google" },
  },
} as const satisfies Readonly<Record<string, ChannelHarness>>;

export type HarnessChannel = keyof typeof HARNESS;

/** The channels the harness knows, in the drivers' order. */
export const HARNESS_CHANNELS = Object.keys(HARNESS) as HarnessChannel[];

/** A channel's examples file. */
export const examplesOf = (channel: HarnessChannel): string => `test/acceptance/examples/${channel}.test.ts`;

/** A channel's reference agent: the first of its agents. */
export const referenceOf = (channel: HarnessChannel): string => Object.keys(HARNESS[channel].agents)[0] as string;

/** Every reference agent by name: the channel it lives in, and where it takes webhooks. */
export const AGENTS: Readonly<Record<string, { channel: HarnessChannel; path: string }>> = Object.fromEntries(
  HARNESS_CHANNELS.flatMap((channel) =>
    Object.entries(HARNESS[channel].agents).map(([name, path]) => [name, { channel, path }] as const),
  ),
);
