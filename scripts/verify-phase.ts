/**
 * `pnpm verify:phase <n> [--group <group>] [--part <part>] [--repeat <k>]`: the gate. Runs the
 * standing checks, then the exit checks of phases 0..n in order (docs/phases.md, "How a gate
 * works"). Every check runs even when an earlier one fails, so one run shows everything that is red.
 *
 * Without `--group` it is the whole gate. CI runs it in pieces side by side (`.github/workflows/ci.yml`):
 * `--group static`, `--group unit`, and `--group accept` once per acceptance part and run
 * (`--part`, `--repeat 1`). Every group, and every part three times, is the whole gate.
 */
import { spawnSync } from "node:child_process";

import { ROOT } from "./lib/generate.ts";

/** Where a check runs in CI: what needs no server, what tests the server and packages, and the acceptance suite. */
type Group = "static" | "unit" | "accept";
const GROUPS: readonly Group[] = ["static", "unit", "accept"];

interface Check {
  name: string;
  /** A package.json script and its arguments. */
  script: readonly string[];
  group: Group;
}

/** Everything else needs the SDK build and the compiled binary, so this runs first and must pass. */
const BUILD = { name: "Build the SDK and the server binary", script: ["build"] } as const;

const STANDING: readonly Check[] = [
  { name: "Types", script: ["typecheck"], group: "static" },
  { name: "Lint and format", script: ["lint"], group: "static" },
  { name: "Unit tests", script: ["test"], group: "unit" },
  { name: "Spec is current", script: ["spec:check"], group: "static" },
  { name: "SDKs are current", script: ["sdk:check"], group: "static" },
  { name: "Linear's schema module matches its SDL", script: ["linear:schema:check"], group: "static" },
  { name: "No secrets in output", script: ["test:redaction"], group: "unit" },
  { name: "No duplicate code", script: ["check:dupes"], group: "static" },
  { name: "Architecture boundaries", script: ["check:deps"], group: "static" },
  { name: "No dead code", script: ["check:unused"], group: "static" },
  { name: "Every package at one version, ready to release", script: ["release:check"], group: "static" },
  { name: "Flake-free acceptance (3 runs)", script: ["test:accept", "--repeat", "3"], group: "accept" },
];

/** Exit checks that aren't already a standing check. 0.5, 0.6 and 0.7 are unit tests; 0.2 is the acceptance run. */
const EXIT_CHECKS: Readonly<Record<number, readonly Check[]>> = {
  0: [
    {
      name: "0.1 The control API needs the token; 0.6 state files are private (compiled binary)",
      script: ["test:integration"],
      group: "unit",
    },
    { name: "0.3 Packaging works", script: ["test:pack"], group: "unit" },
    { name: "0.4 The stale checks catch drift", script: ["test:stale"], group: "static" },
  ],
  // Phase 1's exit checks all run in checks above. The acceptance run (standing) covers 1.1 and
  // 1.2 (`test/acceptance/examples` against both reference agents), 1.5 and 1.7 (`test/acceptance/stack`),
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
  // Phase 4 too. The acceptance run covers 4.1 and 4.2 (every fake Linear example against the
  // `@linear/sdk` and Chat SDK agents, every fake Notion example against the `@notionhq/client`
  // agent), 4.3 for that whole run (`test/acceptance/linear-schemas.setup.ts` holds every GraphQL
  // answer and webhook to Linear's schema), 4.5 (`test/acceptance/checks` against the agents,
  // `checks-broken.test.ts` against the agents with one fault per check) and 4.6
  // (`test/acceptance/examples/shared.test.ts` with one agent per channel). Delivery cases L1 to L3 and N1 to N3
  // (4.4) are in `test:integration`; the schema module is a standing check.
  4: [],
  // Phase 5's checks that need no sandbox are unit tests: 5.3 (`drivers/slack/live/live.test.ts`,
  // allowlists against a Slack stand-in), 5.4 (`server/test/live-unsupported.test.ts`, every
  // fake-only row of the reality matrix), 5.2's cleanup and sweep, and 5.6's doctor
  // (`cli/live.test.ts`). The acceptance run covers 5.4's skip in Vitest (`live-skip.test.ts`).
  // 5.1 and 5.2 against the real sandboxes run nightly (`.github/workflows/live.yml`, `pnpm live`),
  // since they need the `live` environment's secrets.
  5: [],
  // Phase 6: 6.3 is a unit test (`core/ca/ca.test.ts`, a real TLS handshake against the name
  // constraints), and so are the differential run's comparison, the shape differ and the coverage
  // page (`conformance/*.test.ts`, 6.4 and 6.5). The acceptance run covers 6.1 and 6.2 (its `proxy`
  // part: the phase 1 Slack examples against the Bolt agent with only what `channelstack env
  // --proxy` prints, and the Go agent in Docker) and 6.4's scenarios against the fakes (its
  // `conformance` part). CI's `coverage page` job publishes the page (6.5); the differential run
  // against the sandboxes is nightly (`.github/workflows/live.yml`, `pnpm conformance`).
  6: [],
  // Phase 7: 7.1's Rust half is the smoke scenarios through the Rust runner (the acceptance run's
  // smoke part, next to TypeScript and Python); the Rust SDK's own checks are here. The acceptance
  // run covers 7.3 (`test/acceptance/pytest` against Bolt, in its `slack` part) and 7.4
  // (`test/acceptance/mcp.test.ts`); pytest-channelstack's own tests are in `pnpm test`.
  7: [{ name: "7.1 The Rust SDK: clippy and its own tests", script: ["test:rust"], group: "unit" }],
  // 8.2 to 8.6 run in the acceptance and unit checks above, once Resend's examples, agents and
  // checks are enabled; 8.7 and 8.8 in the nightly live run.
  8: [
    { name: "8.1 Every channel is complete and on the channel kit", script: ["check:channels"], group: "static" },
    { name: "8.3 Resend's description is the pinned one", script: ["resend:schema", "--check"], group: "static" },
  ],
  // 9.1 to 9.6 run in the acceptance and unit checks above, once Google's examples, agents and
  // checks are enabled; 9.7 and 9.8 in the nightly live run.
  9: [
    { name: "9.2 Gmail's discovery document is the pinned one", script: ["google:schema", "--check"], group: "static" },
  ],
  // 13.1 and 13.6 (the examples and the pytest port against both OpenAI agents) run in the
  // acceptance check's `openai` part; 13.2 to 13.5, 13.7, 13.8, 13.10 and 13.11 in the unit tests
  // (`server/src/providers/openai`, `server/src/core/{attribution,stream}`) and `test/acceptance`;
  // 13.6 in the Rust SDK's tests (7.1); 13.13 in the nightly job.
  13: [{ name: "13.2 OpenAI's description is the pinned one", script: ["openai:schema", "--check"], group: "static" }],
};

const phase = Number(process.argv[2]);
const flag = (name: string) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const group = flag("--group") as Group | undefined;
if (!Number.isInteger(phase) || !(phase in EXIT_CHECKS) || (group !== undefined && !GROUPS.includes(group))) {
  console.error(
    `Usage: pnpm verify:phase <n> [--group ${GROUPS.join("|")}] [--part <part>] [--repeat <k>], with n one of ${Object.keys(EXIT_CHECKS).join(", ")}`,
  );
  process.exit(2);
}
// One acceptance part, and how many runs of it: CI's pieces of the acceptance check.
const part = flag("--part");
const repeat = flag("--repeat");
const accept = (check: Check): Check =>
  check.group === "accept" && (part !== undefined || repeat !== undefined)
    ? {
        ...check,
        name: `Acceptance${part ? ` (${part})` : ""}, ${repeat ?? "3"} run${repeat === "1" ? "" : "s"}`,
        script: ["test:accept", "--repeat", repeat ?? "3", ...(part ? ["--part", part] : [])],
      }
    : check;

function run(check: Pick<Check, "name" | "script">): {
  check: Pick<Check, "name" | "script">;
  ok: boolean;
  seconds: number;
} {
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
  for (const check of [...STANDING, ...exitChecks]) {
    if (group === undefined || check.group === group) results.push(run(accept(check)));
  }
}

console.log(`\n━━ verify:phase ${phase}${group ? ` (${group}${part ? `, ${part}` : ""})` : ""}`);
for (const { check, ok, seconds } of results)
  console.log(`${ok ? "pass" : "FAIL"}  ${check.name}  (${seconds.toFixed(1)}s)`);
const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`\nAll ${results.length} checks passed`);
