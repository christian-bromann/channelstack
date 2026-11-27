/**
 * `pnpm check:unchanged [--base <ref>]` (exit check 12.1): no example or scenario that existed at
 * the start of the phase was edited to pass. Every `test(...)` of `test/acceptance/examples` at
 * `<ref>` (default the `phase-12-start` tag) must still be there, by its full name ("describe >
 * test"), with the same source; imports and new tests don't count. Every scenario file there must
 * be unchanged.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

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

/** Every `test(...)` in a file, by its full name, with its source as written. */
function testsOf(source: string, file: string): Map<string, string> {
  const tests = new Map<string, string>();
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node, names: readonly string[]) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const [title] = node.arguments;
      const name = title && ts.isStringLiteralLike(title) ? title.text : undefined;
      if (node.expression.text === "describe" && name !== undefined) {
        ts.forEachChild(node, (child) => visit(child, [...names, name]));
        return;
      }
      if (node.expression.text === "test" && name !== undefined) {
        tests.set([...names, name].join(" > "), node.getText(tree));
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, names));
  };
  visit(tree, []);
  return tests;
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
