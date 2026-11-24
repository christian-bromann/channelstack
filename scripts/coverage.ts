/**
 * `pnpm coverage [--results <file>] [--out <file>]`: the coverage page (exit check 6.5), from the
 * spec's capabilities, `conformance/divergences.yaml` and, when given, a differential run's results
 * (`pnpm conformance`). CI uploads it with every run and adds a summary to the job (`--summary`); the nightly
 * job makes it with that night's results.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { parse } from "yaml";

import { type CoverageInput, coveragePage, coverageSummary } from "../conformance/coverage.ts";
import { type ConformanceResults, loadDivergences } from "../conformance/lib.ts";
import { ROOT } from "./lib/generate.ts";

const { values } = parseArgs({
  options: { results: { type: "string" }, out: { type: "string" }, summary: { type: "string" } },
});
const out = values.out ?? join(ROOT, "build", "coverage", "index.html");

/** Each scenario of each channel, with the actions it says it covers (`covers`). */
const scenarios: CoverageInput["scenarios"] = ["slack", "github", "linear", "notion"].flatMap((channel) => {
  const dir = join(ROOT, "scenarios", channel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => {
      const scenario = parse(readFileSync(join(dir, file), "utf8")) as { name: string; covers?: string[] };
      return { name: scenario.name, channel, covers: scenario.covers ?? [] };
    });
});

const input: CoverageInput = {
  spec: JSON.parse(readFileSync(join(ROOT, "spec", "openapi.json"), "utf8")),
  divergences: loadDivergences(join(ROOT, "conformance", "divergences.yaml")),
  scenarios,
  ...(values.results ? { results: JSON.parse(readFileSync(values.results, "utf8")) as ConformanceResults } : {}),
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, coveragePage(input));
// A CI job's summary (`$GITHUB_STEP_SUMMARY`): the page in a few lines.
if (values.summary) appendFileSync(values.summary, coverageSummary(input));
console.log(`coverage: wrote ${out}`);
