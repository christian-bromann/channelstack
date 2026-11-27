/**
 * The live run (exit checks 5.1 and 5.2): every "live mode" block of the four example files
 * against the real sandboxes, then a sweep check that the run left nothing behind
 * (`lib/live-stack.ts`).
 *
 *   node scripts/live.ts [--bin <server>]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { CHANNEL_NAMES, CHANNELS } from "../server/src/drivers/index.ts";
import { ROOT } from "./lib/generate.ts";
import { withLiveStack } from "./lib/live-stack.ts";
import { binaryPath } from "./lib/packages.ts";
import { runAsync } from "./lib/process.ts";

const { values } = parseArgs({ options: { bin: { type: "string" } } });
const bin = values.bin ?? process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();
const env = process.env;

let failed = false;
const ok = await withLiveStack({ bin, env }, async ({ env: live, home, serverLog }) => {
  const report = join(home, "vitest.json");
  try {
    // Not run: the relays in this process forward the platforms' webhooks to the agents meanwhile.
    await runAsync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "test/acceptance/vitest.config.ts",
        ...CHANNEL_NAMES.map((channel) => `test/acceptance/examples/${channel}.test.ts`),
        "-t",
        "live mode",
        // A real platform and a real agent take their time: the examples' own waits (60 s) decide, not Vitest's.
        "--testTimeout",
        "120000",
        "--reporter",
        "verbose",
        "--reporter",
        "json",
        "--outputFile.json",
        report,
      ],
      { cwd: ROOT, env: live },
    );
  } catch (error) {
    failed = true;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  // A channel whose credentials are set must have run live: a run that skipped all of it proves
  // nothing. Without a report (Vitest died), the run has failed already.
  let results: { testResults: Array<{ name: string; assertionResults: Array<{ status: string }> }> } = {
    testResults: [],
  };
  try {
    results = JSON.parse(readFileSync(report, "utf8"));
  } catch {
    failed = true;
    process.stderr.write("Vitest wrote no report: the live tests didn't run\n");
  }
  for (const driver of CHANNELS) {
    const credentials = driver.live?.credentials ?? [];
    if (credentials.length === 0 || credentials.some((name) => !env[name])) continue;
    const file = results.testResults.find((result) =>
      result.name.endsWith(`test/acceptance/examples/${driver.name}.test.ts`),
    );
    if (!file?.assertionResults.some((test) => test.status === "passed")) {
      failed = true;
      process.stderr.write(
        `${driver.name}: its live credentials are set, and no live test of it passed (the reasons are above)\n`,
      );
    }
  }
  if (failed) process.stderr.write(`\nThe server's log:\n${serverLog()}\n`);
});
process.exitCode = failed || !ok ? 1 : 0;
