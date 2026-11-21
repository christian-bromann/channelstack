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
const AGENTS = { "bolt-ai-sdk": join(ROOT, "examples", "agents", "bolt-ai-sdk", "agent.ts") } as const;

/** The `describe` blocks of `api/examples/slack.test.ts` this phase has enabled (docs/phases.md). */
const ENABLED = [
  "mentions and threads",
  "direct messages",
  "reactions, edits and deletes",
  "inspecting what the agent did",
];

export async function runExamples(
  options: { agents?: ReadonlyArray<keyof typeof AGENTS>; bin?: string } = {},
): Promise<void> {
  const bin = options.bin ?? process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();
  if (!existsSync(bin)) throw new Error(`No server binary at ${bin}. Run \`pnpm build\` first.`);
  const pattern = `^(${ENABLED.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}) `;
  for (const name of options.agents ?? (Object.keys(AGENTS) as Array<keyof typeof AGENTS>)) {
    console.log(`\napi/examples against ${name}`);
    await withStack({ bin, agent: AGENTS[name], webhook: { driver: "slack", path: "/slack/events" } }, ({ env }) => {
      run("pnpm", ["exec", "vitest", "run", "--config", "test/acceptance/vitest.config.ts", "-t", pattern], {
        cwd: ROOT,
        env,
      });
    });
  }
}
