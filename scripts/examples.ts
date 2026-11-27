/**
 * Runs `test/acceptance/examples` unchanged against a reference agent and the compiled binary: the acceptance
 * suite. Each phase enables the `describe` blocks it has built.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { AGENTS, examplesOf, HARNESS, HARNESS_CHANNELS, PROVIDERS, referenceOf } from "./lib/channels.ts";
import { ROOT } from "./lib/generate.ts";
import { binaryPath } from "./lib/packages.ts";
import { run } from "./lib/process.ts";
import { withStack } from "./lib/stack.ts";

/**
 * Every channel in one run (exit check 4.6): `test/acceptance/examples/shared.test.ts` against one server with
 * one reference agent per channel, each with its own endpoint.
 */
const SHARED = {
  examples: "test/acceptance/examples/shared.test.ts",
  agents: HARNESS_CHANNELS.map(referenceOf),
  enabled: ["answers in #support", "an admin and a regular member", `(${HARNESS_CHANNELS.join("|")}) checks: `],
};

/**
 * Proxy mode (exit check 6.1): the phase 1 Slack examples against the Bolt reference agent as it
 * is, configured only from `channelstack env --proxy`: with no `SLACK_API_URL` it calls slack.com,
 * and the proxy sends that to the fake.
 */
const PROXY = {
  agent: "bolt-ai-sdk",
  enabled: [
    "mentions and threads > ",
    "direct messages > ",
    "reactions, edits and deletes > ",
    "inspecting what the agent did > ",
    "streaming, status and Stop > ",
  ],
} as const;

/**
 * The examples against each reference agent (all, or these), then `shared.test.ts` with one agent
 * per channel (`shared`, by default only when every agent runs).
 */
export async function runExamples(
  options: { agents?: readonly string[]; shared?: boolean; bin?: string } = {},
): Promise<void> {
  const bin = options.bin ?? process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();
  if (!existsSync(bin)) throw new Error(`No server binary at ${bin}. Run \`pnpm build\` first.`);
  for (const name of options.agents ?? Object.keys(AGENTS)) {
    const agentOf = AGENTS[name];
    if (!agentOf) throw new Error(`No reference agent "${name}" in scripts/lib/channels.ts`);
    const { channel, path } = agentOf;
    const examples = examplesOf(channel);
    const { enabled, suites } = HARNESS[channel];
    console.log(`\ntest/acceptance/examples against ${name}`);
    const agent = join(ROOT, "examples", "agents", name, "agent.ts");
    await withStack({ bin, agent, webhook: { driver: channel, path } }, ({ env }) => {
      const vitest = ["exec", "vitest", "run", "--config", "test/acceptance/vitest.config.ts"];
      run("pnpm", [...vitest, examples, "-t", `^(${enabled.join("|")})`], { cwd: ROOT, env });
      for (const suite of suites) run("pnpm", [...vitest, suite], { cwd: ROOT, env });
    });
  }
  if (!(options.shared ?? options.agents === undefined)) return;
  await runSharedExamples(bin);
}

/** A provider's examples against each of its agents (exit check 13.1): `test/acceptance/examples/<provider>.test.ts`. */
export async function runProviderExamples(
  provider: keyof typeof PROVIDERS,
  options: { bin?: string } = {},
): Promise<void> {
  const bin = options.bin ?? process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();
  if (!existsSync(bin)) throw new Error(`No server binary at ${bin}. Run \`pnpm build\` first.`);
  const { enabled, agents } = PROVIDERS[provider];
  for (const [name, { channel, path }] of Object.entries(agents)) {
    console.log(`\ntest/acceptance/examples/${provider}.test.ts against ${name}`);
    const agent = join(ROOT, "examples", "agents", name, "agent.ts");
    await withStack({ bin, agent, webhook: { driver: channel, path } }, ({ env }) => {
      run(
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "--config",
          "test/acceptance/vitest.config.ts",
          `test/acceptance/examples/${provider}.test.ts`,
          "-t",
          `^(${enabled.join("|")})`,
        ],
        { cwd: ROOT, env },
      );
    });
  }
}

/** The phase 1 Slack examples in proxy mode (exit check 6.1). */
export async function runProxyExamples(options: { bin?: string } = {}): Promise<void> {
  const bin = options.bin ?? process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();
  if (!existsSync(bin)) throw new Error(`No server binary at ${bin}. Run \`pnpm build\` first.`);
  const { channel, path } = AGENTS[PROXY.agent] as { channel: "slack"; path: string };
  console.log(`\ntest/acceptance/examples against ${PROXY.agent} in proxy mode`);
  const agent = join(ROOT, "examples", "agents", PROXY.agent, "agent.ts");
  await withStack({ bin, agent, webhook: { driver: channel, path }, proxy: true }, ({ env }) => {
    run(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "test/acceptance/vitest.config.ts",
        examplesOf(channel),
        "-t",
        `^(${PROXY.enabled.join("|")})`,
      ],
      { cwd: ROOT, env },
    );
  });
}

/**
 * The Go reference agent in Docker, in proxy mode (exit check 6.2): the DM example. It needs Docker,
 * which CI's Linux runners have; elsewhere it is skipped, and says so, unless `CI` is set.
 */
export async function runGoDockerExamples(options: { bin?: string } = {}): Promise<void> {
  const bin = options.bin ?? process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();
  if (!existsSync(bin)) throw new Error(`No server binary at ${bin}. Run \`pnpm build\` first.`);
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    if (process.env.CI) throw new Error("Exit check 6.2 needs Docker, and `docker info` fails");
    console.log("\nSkipped: the Go agent in Docker (exit check 6.2) needs a running Docker; CI runs it");
    return;
  }
  const dir = join(ROOT, "examples", "agents", "go-slack");
  run("docker", ["build", "--quiet", "--tag", "channelstack-go-slack:local", dir], { cwd: ROOT });
  console.log("\ntest/acceptance/examples against the Go agent in Docker, in proxy mode");
  await withStack(
    { bin, agent: join(dir, "agent.ts"), webhook: { driver: "slack", path: "/slack/events" }, proxy: true },
    ({ env }) => {
      run(
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "--config",
          "test/acceptance/vitest.config.ts",
          examplesOf("slack"),
          "-t",
          "^direct messages > a DM to the app gets a reply in the DM$",
        ],
        { cwd: ROOT, env },
      );
    },
  );
}

async function runSharedExamples(bin: string): Promise<void> {
  console.log(`\n${SHARED.examples} against ${SHARED.agents.join(", ")}`);
  const [first, ...rest] = SHARED.agents.map((name) => ({
    agent: join(ROOT, "examples", "agents", name, "agent.ts"),
    webhook: { driver: AGENTS[name]?.channel ?? "", path: AGENTS[name]?.path ?? "" },
  }));
  if (!first) return;
  await withStack({ bin, ...first, others: rest }, ({ env }) => {
    run("pnpm", ["exec", "vitest", "run", "--config", "test/acceptance/vitest.config.ts", SHARED.examples], {
      cwd: ROOT,
      env,
    });
  });
}

/**
 * The pytest port of the Slack conversation tests (exit check 7.3), against the Bolt reference
 * agent: the same stack the Vitest examples run on, driven from Python through pytest-channelstack.
 */
export async function runPytestExamples(options: { bin?: string } = {}): Promise<void> {
  const bin = options.bin ?? process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();
  if (!existsSync(bin)) throw new Error(`No server binary at ${bin}. Run \`pnpm build\` first.`);
  const { channel, path } = AGENTS["bolt-ai-sdk"] as { channel: "slack"; path: string };
  console.log("\ntest/acceptance/pytest against bolt-ai-sdk");
  const agent = join(ROOT, "examples", "agents", "bolt-ai-sdk", "agent.ts");
  await withStack({ bin, agent, webhook: { driver: channel, path } }, ({ env }) => {
    const project = join(ROOT, "integrations", "pytest-channelstack");
    run("uv", ["run", "--project", project, "--frozen", "pytest", "test/acceptance/pytest"], { cwd: ROOT, env });
  });
}
