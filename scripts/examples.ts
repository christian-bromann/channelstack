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

/** The reference agents the examples run against, by name. */
const AGENTS = {
  "bolt-ai-sdk": join(ROOT, "examples", "agents", "bolt-ai-sdk", "agent.ts"),
  "chat-sdk-slack": join(ROOT, "examples", "agents", "chat-sdk-slack", "agent.ts"),
} as const;

/**
 * What this phase has enabled of `api/examples/slack.test.ts` (docs/phases.md), as patterns on
 * Vitest's full test names ("describe > test"): whole `describe` blocks, and single tests of
 * blocks that later phases complete.
 */
const ENABLED = [
  "mentions and threads > ",
  "direct messages > ",
  "buttons, menus, modals and commands > ",
  "streaming, status and Stop > ",
  "reactions, edits and deletes > ",
  "inspecting what the agent did > ",
  // Everything but the Socket Mode test, which needs an agent started in Socket Mode (exit check 2.2).
  "delivery and failures \\(fake only\\) > (?!reconnects after the Socket Mode)",
];

/** Matches the full name ("describe > test") of every example test this phase has enabled. */
export const ENABLED_TESTS = new RegExp(`^(${ENABLED.join("|")})`);

export async function runExamples(
  options: { agents?: ReadonlyArray<keyof typeof AGENTS>; bin?: string } = {},
): Promise<void> {
  const bin = options.bin ?? process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();
  if (!existsSync(bin)) throw new Error(`No server binary at ${bin}. Run \`pnpm build\` first.`);
  for (const name of options.agents ?? (Object.keys(AGENTS) as Array<keyof typeof AGENTS>)) {
    console.log(`\napi/examples against ${name}`);
    await withStack({ bin, agent: AGENTS[name], webhook: { driver: "slack", path: "/slack/events" } }, ({ env }) => {
      const vitest = ["exec", "vitest", "run", "--config", "test/acceptance/vitest.config.ts"];
      run("pnpm", [...vitest, "api/examples", "-t", ENABLED_TESTS.source], { cwd: ROOT, env });
      // The tests that need a server and an agent but aren't examples (quiet, parallel sessions).
      run("pnpm", [...vitest, "test/acceptance/stack"], { cwd: ROOT, env });
    });
  }
}
