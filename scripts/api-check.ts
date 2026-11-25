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
 * Contract types that aren't handles, so the generated SDK has no class of that name: the bases
 * whose members every handle repeats (checked there), configuration, the test integration's own
 * types, and option bags (the examples check them as the methods' parameters).
 */
const NOT_HANDLES = new Set([
  ...["Principal", "User", "App", "Resource", "HasTranscript", "Inspectable", "Delivery", "ResendOptions"],
  ...["DeliveryFilter", "ApiCall", "ApiCallFilter", "Transcript", "TranscriptEntry"],
  ...["ChannelstackConfig", "ServerConfig", "SlackConfig", "SlackLiveApp", "SlackAppUrls", "GitHubConfig"],
  ...["GitHubAppConfig", "LinearConfig", "LinearAppConfig", "NotionConfig", "NotionIntegrationConfig"],
  ...["ChannelstackFixture", "ChannelstackIntegrationOptions", "ChannelstackMatchers", "TextOptions"],
  ...["SlackUserOptions", "SlackChannelOptions", "GitHubUserOptions", "GitHubRepoOptions", "LinearUserOptions"],
  ...["LinearTeamOptions", "NotionUserOptions", "NotionPageOptions", "NotionDatabaseOptions"],
]);

/** What the contract declares and the generated SDK doesn't have yet, each with the issue that tracks it. */
const KNOWN_GAPS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    [
      ...["SlackApp", "SlackUser", "SlackConversation", "GitHubApp", "GitHubUser", "GitHubRepo"],
      ...["LinearApp", "LinearUser", "LinearTeam"],
    ].map((type) => [`${type}.channel`, "#36"]),
  ),
  ...Object.fromEntries(
    ["SlackConversation", "GitHubRepo", "LinearTeam", "NotionPage", "NotionDatabase"].map((type) => [
      `${type}.uiUrl`,
      "#36",
    ]),
  ),
  "SlackUser.renameChannel": "#37",
  "SlackUser.archiveChannel": "#37",
  SlackChannel: "#37",
  SlackDM: "#37",
  SlackAgentThread: "#37",
  SlackInjectedFault: "#37",
};

/** Each contract handle's members against the generated handle's: what is missing, or not a method where it should be. */
function memberGaps(): string[] {
  const contractEntry = join(ROOT, "api", "index.d.ts");
  const sdkEntry = join(ROOT, "sdks", "typescript", "client.ts");
  const both = ts.createProgram([contractEntry, sdkEntry], { ...options, noEmit: true });
  const checker = both.getTypeChecker();
  const exported = (file: string) => {
    const source = both.getSourceFile(file);
    const module = source && checker.getSymbolAtLocation(source);
    if (!module) throw new Error(`Can't read the exports of ${file}`);
    return new Map(
      checker
        .getExportsOfModule(module)
        .map((symbol) => [
          symbol.name,
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol,
        ]),
    );
  };
  const callable = (symbol: ts.Symbol) =>
    checker.getNonNullableType(checker.getTypeOfSymbol(symbol)).getCallSignatures().length > 0;
  const sdk = exported(sdkEntry);
  const gaps: string[] = [];
  for (const [name, symbol] of exported(contractEntry)) {
    if (!(symbol.flags & ts.SymbolFlags.Interface) || NOT_HANDLES.has(name)) continue;
    const generated = sdk.get(name);
    if (!generated || !(generated.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface))) {
      gaps.push(name);
      continue;
    }
    const contractType = checker.getDeclaredTypeOfSymbol(symbol);
    const generatedType = checker.getDeclaredTypeOfSymbol(generated);
    for (const member of checker.getPropertiesOfType(contractType)) {
      // `[Symbol.asyncDispose]` and the like: generated from the routes marked `dispose`.
      if (member.name.startsWith("__@")) continue;
      const counterpart = checker.getPropertyOfType(generatedType, member.name);
      if (!counterpart) gaps.push(`${name}.${member.name}`);
      else if (callable(member) !== callable(counterpart)) gaps.push(`${name}.${member.name} (method vs property)`);
    }
  }
  return gaps;
}

const gaps = memberGaps();
const unknown = gaps.filter((gap) => !(gap in KNOWN_GAPS));
const closed = Object.keys(KNOWN_GAPS).filter((gap) => !gaps.includes(gap));
console.log(`api:check: ${gaps.length} contract members or handles not generated yet, each tracked (KNOWN_GAPS)`);
if (unknown.length > 0) {
  blocking.push(
    `the generated SDK doesn't have what the contract declares (fix it, or list it in KNOWN_GAPS with its issue):\n${unknown.map((gap) => `      ${gap}`).join("\n")}`,
  );
}
if (closed.length > 0) {
  blocking.push(
    `KNOWN_GAPS lists what the generated SDK now has; remove it:\n${closed.map((gap) => `      ${gap}`).join("\n")}`,
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
  "api:check: every enabled example type-checks against the generated SDK, and every other contract member is generated",
);
