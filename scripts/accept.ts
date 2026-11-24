/**
 * `pnpm test:accept [--part <part>] [--repeat <n>]`: the acceptance suite, n runs in a row (flake check).
 * The suite is the smoke scenarios through every SDK, then `api/examples` and the stack tests
 * against each reference agent, then the tests in `test/acceptance` that bring their own agent.
 *
 * `--part` runs one part of it, so CI can run the parts side by side (`.github/workflows/ci.yml`);
 * every part, run once each, is the whole suite once.
 */
import { runExamples, runProxyExamples } from "./examples.ts";
import { ROOT } from "./lib/generate.ts";
import { run } from "./lib/process.ts";
import { runSmoke, SDKS } from "./smoke.ts";

const vitest = ["exec", "vitest", "run", "--project", "acceptance"];
const BROKEN = "test/acceptance/checks-broken.test.ts";
/** The standard checks against the agents with one fault per check, for some channels (`checks-broken.test.ts`). */
const broken = (channels: string) => () =>
  run("pnpm", [...vitest, BROKEN], { cwd: ROOT, env: { ...process.env, CHANNELSTACK_BROKEN_CHANNELS: channels } });

/** The parts, each well under five minutes on CI, and together the whole suite. */
const PARTS: Readonly<Record<string, () => Promise<void> | void>> = {
  slack: () => runExamples({ agents: ["bolt-ai-sdk", "chat-sdk-slack"], shared: false }),
  "github-linear": () =>
    runExamples({ agents: ["probot", "chat-sdk-github", "linear-sdk", "chat-sdk-linear"], shared: false }),
  // The smoke scenarios through every SDK, Notion, every channel in one run, and the tests that bring their own agent.
  "notion-shared-own": async () => {
    await runSmoke({ sdks: SDKS });
    await runExamples({ agents: ["notion-sdk"], shared: true });
    run("pnpm", [...vitest, "--exclude", BROKEN], { cwd: ROOT });
  },
  // Proxy mode: the Slack examples against an agent that only knows slack.com (exit check 6.1).
  proxy: () => runProxyExamples(),
  "broken-slack": broken("slack"),
  "broken-others": broken("github,linear,notion"),
};

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
