/**
 * `pnpm check:unchanged [--base <ref>]` (exit check 12.1): no example or scenario that existed at
 * the start of the phase was edited to pass. Every test of `test/acceptance/examples` at
 * `<ref>` (default the `phase-12-start` tag) must still be there, by its full name ("describe >
 * test"), with the same source; imports and new tests don't count. A test is any `test(…)` or
 * `it(…)`, with its modifiers (`test.skipIf(…)(…)`, `test.concurrent(…)`, `test.for(…)(…)`).
 * Every scenario file there must be unchanged.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { testsOf } from "./lib/tests-of.ts";

const ROOT = join(import.meta.dirname, "..");
const flag = (name: string) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const base = flag("--base") ?? "phase-12-start";

const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });

/** The base commit, fetched if this checkout doesn't have it (CI clones one commit, without tags). */
function baseCommit(): string {
  try {
    return git("rev-parse", "--verify", `${base}^{commit}`).trim();
  } catch {
    git("fetch", "--no-tags", "--depth=1", "origin", `refs/tags/${base}:refs/tags/${base}`);
    return git("rev-parse", "--verify", `${base}^{commit}`).trim();
  }
}

const commit = baseCommit();
const atBase = (pattern: string) => git("ls-tree", "-r", "--name-only", commit, pattern).split("\n").filter(Boolean);
const problems: string[] = [];

for (const file of atBase("test/acceptance/examples").filter((path) => path.endsWith(".test.ts"))) {
  const before = testsOf(git("show", `${commit}:${file}`), file);
  let now: Map<string, string>;
  try {
    now = testsOf(readFileSync(join(ROOT, file), "utf8"), file);
  } catch {
    problems.push(`${file} is gone`);
    continue;
  }
  for (const [name, source] of before) {
    const current = now.get(name);
    if (current === undefined) problems.push(`${file}: "${name}" is gone`);
    else if (current !== source) problems.push(`${file}: "${name}" changed`);
  }
}

for (const file of atBase("scenarios").filter((path) => path.endsWith(".yaml"))) {
  let current: string | undefined;
  try {
    current = readFileSync(join(ROOT, file), "utf8");
  } catch {
    current = undefined;
  }
  if (current === undefined) problems.push(`${file} is gone`);
  else if (current !== git("show", `${commit}:${file}`)) problems.push(`${file} changed`);
}

if (problems.length > 0) {
  console.error(`check:unchanged: ${problems.length} existing tests changed since ${base}:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`check:unchanged: every example and scenario of ${base} is unchanged`);
