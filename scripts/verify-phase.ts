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
  { name: "Linear's schema module matches its SDL", script: ["linear:schema:check"] },
  { name: "The examples type-check against the generated SDK", script: ["api:check"] },
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
  // Phase 1's exit checks all run in checks above. The acceptance run (standing) covers 1.1 and
  // 1.2 (`api/examples` against both reference agents), 1.5 and 1.7 (`test/acceptance/stack`),
  // 1.4 and 1.6 (`test/acceptance`). 1.3 (delivery cases against Bolt) is in `test:integration`.
  1: [],
  // Phase 2 likewise. The acceptance run covers 2.1 (every fake Slack example against both
  // agents) and 2.3 (`test/acceptance/checks` against both, `checks-broken.test.ts` against the
  // agent with one fault per check), and the Socket Mode half of 2.2 (`socket-mode.test.ts`).
  // Delivery cases S2 to S5 and K1 to K4 against Bolt are in `test:integration`.
  2: [],
  // Phase 3 as well. The acceptance run covers 3.1 (every fake GitHub example against Probot and
  // the Chat SDK agent), 3.2 and 3.3 for that whole run (`test/acceptance/github-schemas.setup.ts`
  // holds every call and webhook of each test to GitHub's schemas) and 3.4 (`test/acceptance/checks`
  // against both agents, `checks-broken.test.ts` against the agent with one fault per check). The
  // unit tests cover 3.2 and 3.3 for every route of the fake (`github-conformance.test.ts`), and
  // delivery cases G1 to G3 with `@octokit/webhooks` (3.5) are in `test:integration`.
  3: [],
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
