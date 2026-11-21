/**
 * `pnpm verify:phase <n>`: the gate. Runs the standing checks, then the exit checks of
 * phases 0..n in order (docs/phases.md, "How a gate works"). Every check runs even when
 * an earlier one fails, so one run shows everything that is red.
 */
import { spawnSync } from "node:child_process";
import { ROOT } from "./lib/generate.ts";

interface Check {
  name: string;
  /** A package.json script and its arguments. */
  script: readonly string[];
}

/** Everything else needs the SDK build and the compiled binary, so this runs first and must pass. */
const BUILD: Check = { name: "Build the SDK and the server binary", script: ["build"] };

const STANDING: readonly Check[] = [
  { name: "Types", script: ["typecheck"] },
  { name: "Lint and format", script: ["lint"] },
  { name: "Unit tests", script: ["test"] },
  { name: "Spec is current", script: ["spec:check"] },
  { name: "SDKs are current", script: ["sdk:check"] },
  { name: "No secrets in output", script: ["test:redaction"] },
  { name: "No duplicate code", script: ["check:dupes"] },
  { name: "Architecture boundaries", script: ["check:deps"] },
  { name: "No dead code", script: ["check:unused"] },
  { name: "Flake-free acceptance (3 runs)", script: ["test:accept", "--repeat", "3"] },
];

/** Exit checks that aren't already a standing check. 0.5, 0.6 and 0.7 are unit tests; 0.2 is the acceptance run. */
const EXIT_CHECKS: Readonly<Record<number, readonly Check[]>> = {
  0: [
    {
      name: "0.1 The control API needs the token; 0.6 state files are private (compiled binary)",
      script: ["test:integration"],
    },
    { name: "0.3 Packaging works", script: ["test:pack"] },
    { name: "0.4 The stale checks catch drift", script: ["test:stale"] },
  ],
};

const phase = Number(process.argv[2]);
if (!Number.isInteger(phase) || !(phase in EXIT_CHECKS)) {
  console.error(`Usage: pnpm verify:phase <n>, with n one of ${Object.keys(EXIT_CHECKS).join(", ")}`);
  process.exit(2);
}

function run(check: Check): { check: Check; ok: boolean; seconds: number } {
  console.log(`\n━━ ${check.name} (pnpm ${check.script.join(" ")})`);
  const started = Date.now();
  const result = spawnSync("pnpm", ["run", ...check.script], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return { check, ok: result.status === 0, seconds: (Date.now() - started) / 1000 };
}

const results = [run(BUILD)];
if (results[0]?.ok) {
  const exitChecks = Object.entries(EXIT_CHECKS)
    .filter(([n]) => Number(n) <= phase)
    .flatMap(([, checks]) => checks);
  for (const check of [...STANDING, ...exitChecks]) results.push(run(check));
}

console.log(`\n━━ verify:phase ${phase}`);
for (const { check, ok, seconds } of results)
  console.log(`${ok ? "pass" : "FAIL"}  ${check.name}  (${seconds.toFixed(1)}s)`);
const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`\nAll ${results.length} checks passed`);
