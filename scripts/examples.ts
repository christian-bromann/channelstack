/**
 * Runs `api/examples` unchanged against a reference agent and the compiled binary: the acceptance
 * suite. Each phase enables the `describe` blocks it has built.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ROOT } from "./lib/generate.ts";
import { binaryPath } from "./lib/packages.ts";
import { run } from "./lib/process.ts";
import { withStack } from "./lib/stack.ts";

/** What each channel's reference agents run: its examples, and the tests that need a server and such an agent. */
const CHANNELS = {
  slack: {
    examples: "api/examples/slack.test.ts",
    /**
     * What is enabled of the examples (docs/phases.md), as patterns on Vitest's full test names
     * ("describe > test"): whole `describe` blocks, and single tests of blocks a later phase completes.
     */
    enabled: [
      "mentions and threads > ",
      "direct messages > ",
      "buttons, menus, modals and commands > ",
      "streaming, status and Stop > ",
      "reactions, edits and deletes > ",
      "inspecting what the agent did > ",
      // Everything but the Socket Mode test, which needs an agent started in Socket Mode (exit check 2.2).
      "delivery and failures \\(fake only\\) > (?!reconnects after the Socket Mode)",
    ],
    // Quiet and parallel sessions (not examples), and the standard checks as a developer adds them (exit check 2.3).
    suites: ["test/acceptance/stack", "test/acceptance/checks/slack-checks.test.ts"],
  },
  github: {
    examples: "api/examples/github.test.ts",
    enabled: [
      "issues > ",
      "pull requests and reviews > ",
      "pushes and check runs > ",
      "delivery and failures \\(fake only\\) > ",
      "inspecting what the agent did > ",
    ],
    // The standard checks as a developer adds them (exit check 3.4).
    suites: ["test/acceptance/checks/github-checks.test.ts"],
  },
  linear: {
    examples: "api/examples/linear.test.ts",
    enabled: [
      "delegation and agent sessions > ",
      "conversation inside a session > ",
      "issue workflow > ",
      "delivery and failures \\(fake only\\) > ",
      "inspecting what the agent did > ",
    ],
    // The standard checks as a developer adds them (exit check 4.5).
    suites: ["test/acceptance/checks/linear-checks.test.ts"],
  },
  notion: {
    examples: "api/examples/notion.test.ts",
    enabled: [
      "comments and discussions > ",
      "connections > ",
      "pages and databases > ",
      "delivery and failures \\(fake only\\) > ",
    ],
    suites: ["test/acceptance/checks/notion-checks.test.ts"],
  },
} as const;

/** The reference agents the examples run against, by name: the channel they live in, and where they take webhooks. */
const AGENTS = {
  "bolt-ai-sdk": { channel: "slack", path: "/slack/events" },
  "chat-sdk-slack": { channel: "slack", path: "/slack/events" },
  probot: { channel: "github", path: "/api/github/webhooks" },
  "chat-sdk-github": { channel: "github", path: "/api/webhooks/github" },
  "linear-sdk": { channel: "linear", path: "/webhooks/linear" },
  "chat-sdk-linear": { channel: "linear", path: "/api/webhooks/linear" },
  "notion-sdk": { channel: "notion", path: "/webhooks/notion" },
} as const;

/**
 * Every channel in one run (exit check 4.6): `api/examples/shared.test.ts` against one server with
 * one reference agent per channel, each with its own endpoint.
 */
const SHARED = {
  examples: "api/examples/shared.test.ts",
  agents: ["bolt-ai-sdk", "probot", "linear-sdk", "notion-sdk"],
  enabled: ["answers in #support", "an admin and a regular member", "(slack|github|linear|notion) checks: "],
} as const;

/** Matches the full name ("describe > test") of every example test this phase has enabled, in any channel. */
export const ENABLED_TESTS = new RegExp(
  `^(${[...Object.values(CHANNELS).flatMap((channel) => channel.enabled), ...SHARED.enabled].join("|")})`,
);

export async function runExamples(
  options: { agents?: ReadonlyArray<keyof typeof AGENTS>; bin?: string } = {},
): Promise<void> {
  const bin = options.bin ?? process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();
  if (!existsSync(bin)) throw new Error(`No server binary at ${bin}. Run \`pnpm build\` first.`);
  for (const name of options.agents ?? (Object.keys(AGENTS) as Array<keyof typeof AGENTS>)) {
    const { channel, path } = AGENTS[name];
    const { examples, enabled, suites } = CHANNELS[channel];
    console.log(`\napi/examples against ${name}`);
    const agent = join(ROOT, "examples", "agents", name, "agent.ts");
    await withStack({ bin, agent, webhook: { driver: channel, path } }, ({ env }) => {
      const vitest = ["exec", "vitest", "run", "--config", "test/acceptance/vitest.config.ts"];
      run("pnpm", [...vitest, examples, "-t", `^(${enabled.join("|")})`], { cwd: ROOT, env });
      for (const suite of suites) run("pnpm", [...vitest, suite], { cwd: ROOT, env });
    });
  }
  if (options.agents !== undefined) return;
  console.log(`\n${SHARED.examples} against ${SHARED.agents.join(", ")}`);
  const [first, ...rest] = SHARED.agents.map((name) => ({
    agent: join(ROOT, "examples", "agents", name, "agent.ts"),
    webhook: { driver: AGENTS[name].channel, path: AGENTS[name].path },
  }));
  if (!first) return;
  await withStack({ bin, ...first, others: rest }, ({ env }) => {
    run("pnpm", ["exec", "vitest", "run", "--config", "test/acceptance/vitest.config.ts", SHARED.examples], {
      cwd: ROOT,
      env,
    });
  });
}
