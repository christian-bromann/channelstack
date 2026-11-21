/**
 * `pnpm api:check`: the examples type-check against the generated TypeScript SDK and the test
 * integrations, not only against the hand-written contract in `api/*.d.ts`.
 *
 * The examples cover every phase. An error inside a test this phase has enabled (the same list
 * the acceptance run uses) fails the check; errors in tests of later phases are counted, so the
 * number is seen going down.
 */
import { join, relative } from "node:path";

import ts from "typescript";

import { ENABLED_TESTS } from "./examples.ts";
import { ROOT } from "./lib/generate.ts";

const configPath = join(ROOT, "api", "tsconfig.generated.json");
const config = ts.getParsedCommandLineOfConfigFile(
  configPath,
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  },
);
if (!config) throw new Error(`Can't read ${configPath}`);
const program = ts.createProgram(config.fileNames, config.options);

/** "describe > test" for the test a position is in, the way Vitest names it. Undefined outside any test. */
function testAt(file: ts.SourceFile, position: number): string | undefined {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (position < node.getStart(file) || position >= node.getEnd()) return;
    if (ts.isCallExpression(node)) {
      // `describe("…")`, `test("…")`, and `test.skipIf(…)("…")`.
      const callee = node.expression.getText(file);
      const [title] = node.arguments;
      if (/^(describe|test)\b/.test(callee) && title && ts.isStringLiteralLike(title)) names.push(title.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names.length < 2 ? undefined : names.join(" > ");
}

const blocking: string[] = [];
const later = new Map<string, number>();
for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start === undefined) {
    blocking.push(message);
    continue;
  }
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const where = `${relative(ROOT, diagnostic.file.fileName)}:${line + 1}:${character + 1}`;
  const test = testAt(diagnostic.file, diagnostic.start);
  // Outside the examples, or outside any test, or in a test this phase runs: it has to be right.
  if (test === undefined || ENABLED_TESTS.test(test)) blocking.push(`${where}  ${test ?? ""}\n    ${message}`);
  else later.set(test, (later.get(test) ?? 0) + 1);
}

const total = [...later.values()].reduce((sum, count) => sum + count, 0);
if (total > 0) {
  console.log(`api:check: ${total} type errors in ${later.size} example tests of later phases (not built yet):`);
  for (const [test, count] of later) console.log(`  ${count}  ${test}`);
}
if (blocking.length > 0) {
  console.error(`\napi:check: ${blocking.length} type errors against the generated SDK:\n`);
  for (const entry of blocking) console.error(`  ${entry}`);
  process.exit(1);
}
console.log("api:check: every enabled example type-checks against the generated SDK");
