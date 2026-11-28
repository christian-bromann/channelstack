/**
 * `pnpm test:accept [--part <part>] [--repeat <n>]`: the acceptance suite, n runs in a row (flake check).
 * The suite is the smoke scenarios through every SDK, then `test/acceptance/examples` and the stack tests
 * against each reference agent, then the tests in `test/acceptance` that bring their own agent.
 *
 * `--part` runs one part of it, so CI can run the parts side by side (`.github/workflows/ci.yml`);
 * every part, run once each, is the whole suite once.
 */
import { join } from "node:path";

import {
  runExamples,
  runGoDockerExamples,
  runProviderExamples,
  runProviderProxyExamples,
  runProxyExamples,
  runPytestExamples,
} from "./examples.ts";
import { HARNESS, HARNESS_CHANNELS } from "./lib/channels.ts";
import { ROOT } from "./lib/generate.ts";
import { run } from "./lib/process.ts";
import { runSmoke, SDKS } from "./smoke.ts";

const vitest = ["exec", "vitest", "run", "--project", "acceptance"];
const BROKEN = "test/acceptance/checks-broken.test.ts";
/** The standard checks against the agents with one fault per check, for some channels (`checks-broken.test.ts`). */
const broken = (channels: string) => () =>
  run("pnpm", [...vitest, BROKEN], { cwd: ROOT, env: { ...process.env, CHANNELSTACK_BROKEN_CHANNELS: channels } });

/** A channel's examples against each of its reference agents, without `shared.test.ts`. */
const agentsOf = (...channels: Array<keyof typeof HARNESS>) =>
  runExamples({ agents: channels.flatMap((channel) => Object.keys(HARNESS[channel].agents)), shared: false });

/**
 * The parts, each well under five minutes on CI, and together the whole suite. The channels that
 * share a part are grouped here by how long they take; any other channel gets a part of its own.
 */
const GROUPED: readonly string[] = ["slack", "github", "linear", "notion"];
const PARTS: Readonly<Record<string, () => Promise<void> | void>> = {
  // The Slack examples against both Slack agents, then their pytest port against Bolt (exit check 7.3).
  slack: async () => {
    await agentsOf("slack");
    await runPytestExamples();
  },
  "github-linear": () => agentsOf("github", "linear"),
  // The smoke scenarios through every SDK, Notion, every channel in one run, and the tests that bring their own agent.
  "notion-shared-own": async () => {
    await runSmoke({ sdks: SDKS });
    await runExamples({ agents: Object.keys(HARNESS.notion.agents), shared: true });
    run("pnpm", [...vitest, "--exclude", BROKEN], { cwd: ROOT });
  },
  // Proxy mode: the Slack examples against an agent that only knows slack.com (exit check 6.1), and
  // the Go agent in Docker (6.2).
  proxy: async () => {
    await runProxyExamples();
    await runGoDockerExamples();
    // The OpenAI agent with a hard-coded api.openai.com (exit check 13.12).
    await runProviderProxyExamples("openai");
  },
  // Each conformance scenario against the fake (exit check 6.4); the nightly job runs them live too.
  conformance: () => run(process.execPath, [join(ROOT, "scripts", "conformance.ts"), "--fake-only"], { cwd: ROOT }),
  // The fake OpenAI's examples against the agents on the official SDK and the AI SDK (exit check 13.1).
  openai: async () => {
    await runProviderExamples("openai");
    // The model checks against the agent with one fault per check (exit check 13.9).
    await broken("openai")();
  },
  "broken-slack": broken("slack"),
  "broken-others": broken(HARNESS_CHANNELS.filter((channel) => channel !== "slack").join(",")),
  ...Object.fromEntries(
    HARNESS_CHANNELS.filter((channel) => !GROUPED.includes(channel)).map((channel) => [
      channel,
      () => agentsOf(channel),
    ]),
  ),
};

/** `--parts`: the parts' names, for `pnpm check:channels` to hold CI's matrix to. */
if (process.argv.includes("--parts")) {
  console.log(JSON.stringify(Object.keys(PARTS)));
  process.exit(0);
}

const flag = (name: string) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const repeat = Number(flag("--repeat") ?? "1");
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat takes a positive number");
const part = flag("--part");
if (part !== undefined && !(part in PARTS)) {
  throw new Error(`--part takes one of ${Object.keys(PARTS).join(", ")}, got "${part}"`);
}

for (let attempt = 1; attempt <= repeat; attempt++) {
  console.log(`\nacceptance run ${attempt} of ${repeat}${part ? ` (${part})` : ""}`);
  for (const [name, runPart] of Object.entries(PARTS)) {
    if (part === undefined || part === name) await runPart();
  }
}
console.log(`\nacceptance: ${repeat} of ${repeat} runs green`);
