/**
 * `pnpm api:check`: the generated TypeScript SDK against the hand-written contract in `api/*.d.ts`.
 *
 * - **The examples** type-check against the generated SDK and the test integrations. The examples
 *   cover every phase. An error inside a test this phase has enabled (the same list the acceptance
 *   run uses) fails the check; errors in tests of later phases are counted, so the number is seen
 *   going down.
 * - **Every member** of every handle the contract declares exists on the generated handle of the
 *   same name, as a method where the contract has a method. The examples only see what they call.
 *   A gap is either listed in `KNOWN_GAPS` with its issue, or the check fails; so is a listed gap
 *   that is gone, so the list only gets shorter.
 */
import { join, relative } from "node:path";

import ts from "typescript";

import { checkContract } from "../codegen/src/contract.ts";
import { CHANNELS } from "../server/src/drivers/index.ts";
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
const { options } = config;
const program = ts.createProgram(config.fileNames, options);

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

/**
 * Contract types nothing implements by that name: the bases whose members every handle repeats
 * (checked there), the matchers' own option type, and option bags (every `…Options`, which the
 * examples check as the methods' parameters).
 */
const BASES = new Set([
  ...["Principal", "User", "App", "Resource", "HasTranscript", "SlackHasTranscript", "Inspectable", "Delivery"],
  ...["DeliveryFilter", "ApiCallFilter", "ChannelstackMatchers", "TextOptions"],
]);
const NOT_HANDLES = (name: string) => BASES.has(name) || name.endsWith("Options");

/** Value types the SDK has once per channel: each channel's is compared with the contract's. */
const PER_CHANNEL = Object.fromEntries(
  ["ApiCall", "Transcript", "TranscriptEntry"].map((name) => [name, CHANNELS.map((channel) => channel.title)]),
);

/** What the contract declares and nothing implements yet, each with the issue that tracks it. */
const KNOWN_GAPS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    [
      ...["SlackApp", "SlackUser", "SlackConversation", "GitHubApp", "GitHubUser", "GitHubRepo"],
      ...["LinearApp", "LinearUser", "LinearTeam"],
    ].map((type) => [`${type}.channel`, "#36"]),
  ),
  // Only Slack's transcript entries stream or are seen by one person so far.
  ...Object.fromEntries(
    CHANNELS.filter((channel) => channel.name !== "slack").flatMap(({ title }) => [
      [`${title}TranscriptEntry.streaming`, "#40"],
      [`${title}TranscriptEntry.visibleTo`, "#40"],
    ]),
  ),
  SlackInjectedFault: "#37",
};

const contract = checkContract({
  contract: join(ROOT, "api", "index.d.ts"),
  implementations: [join(ROOT, "sdks", "typescript", "client.ts"), join(ROOT, "integrations", "vitest", "index.ts")],
  notImplemented: NOT_HANDLES,
  perChannel: PER_CHANNEL,
  known: KNOWN_GAPS,
  options,
});
console.log(
  `api:check: ${contract.gaps.length} contract members or types not implemented yet, each tracked (KNOWN_GAPS)`,
);
if (contract.untracked.length > 0) {
  blocking.push(
    `the generated SDK doesn't have what the contract declares (fix it, or list it in KNOWN_GAPS with its issue):\n${contract.untracked.map((gap) => `      ${gap}`).join("\n")}`,
  );
}
if (contract.closed.length > 0) {
  blocking.push(
    `KNOWN_GAPS lists what the generated SDK now has; remove it:\n${contract.closed.map((gap) => `      ${gap}`).join("\n")}`,
  );
}

const total = [...later.values()].reduce((sum, count) => sum + count, 0);
if (total > 0) {
  console.log(`api:check: ${total} type errors in ${later.size} example tests of later phases (not built yet):`);
  for (const [test, count] of later) console.log(`  ${count}  ${test}`);
}
if (blocking.length > 0) {
  console.error(`\napi:check: ${blocking.length} problems with the generated SDK against the contract:\n`);
  for (const entry of blocking) console.error(`  ${entry}`);
  process.exit(1);
}
console.log(
  "api:check: every enabled example type-checks against the generated SDK, and every contract member is implemented or tracked",
);
