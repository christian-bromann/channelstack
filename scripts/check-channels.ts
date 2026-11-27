/**
 * `pnpm check:channels` (exit check 8.1): every channel has every piece a person writes for it
 * (docs/adding-a-channel.md), and no driver goes around the channel kit. It names what is missing
 * and where, so adding a channel is following its failures until there are none.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import * as checks from "../integrations/checks/index.ts";
import { CHANNELS, DRIVERS } from "../server/src/drivers/index.ts";
import { HARNESS, HARNESS_CHANNELS } from "./lib/channels.ts";
import { ROOT } from "./lib/generate.ts";

const problems: string[] = [];
const read = (path: string) => (existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), "utf8") : undefined);
const need = (ok: boolean, problem: string) => {
  if (!ok) problems.push(problem);
};

// --- What a channel needs, each piece where adding-a-channel.md says ------------------------------

const matrix = read("docs/reality-matrix.md") ?? "";
const live = read(".github/workflows/live.yml") ?? "";
const envDocs = read("website/docs/reference/environment-variables.md") ?? "";
const checkExports = checks as unknown as Record<string, unknown>;

for (const channel of CHANNELS) {
  const { name, title } = channel;
  const upper = name.toUpperCase();
  const of = `${title} (${name})`;
  need(
    existsSync(join(ROOT, `test/acceptance/examples/${name}.test.ts`)),
    `${of}: no examples, test/acceptance/examples/${name}.test.ts`,
  );
  const harness = (HARNESS as Record<string, (typeof HARNESS)[keyof typeof HARNESS] | undefined>)[name];
  need(harness !== undefined, `${of}: no entry in scripts/lib/channels.ts (HARNESS)`);
  for (const agent of [...Object.keys(harness?.agents ?? {}), ...(harness ? [harness.broken.agent] : [])]) {
    need(
      existsSync(join(ROOT, "examples", "agents", agent, "agent.ts")),
      `${of}: no agent examples/agents/${agent}/agent.ts`,
    );
  }
  need(Array.isArray(checkExports[`${upper}_CHECKS`]), `${of}: integrations/checks exports no ${upper}_CHECKS`);
  need(typeof checkExports[`${name}Checks`] === "function", `${of}: integrations/checks exports no ${name}Checks()`);
  // Vitest reads a test's fixtures from how it destructures its context: the checks name every channel's.
  need(
    new RegExp(`\\n\\s+${name},\\n`).test(read("integrations/checks/index.ts") ?? ""),
    `${of}: the checks' registrar (integrations/checks/index.ts) doesn't destructure the ${name} fixture`,
  );
  need(
    existsSync(join(ROOT, `test/acceptance/checks/${name}-checks.test.ts`)),
    `${of}: no test/acceptance/checks/${name}-checks.test.ts`,
  );
  const scenarios = join(ROOT, "scenarios", name);
  need(
    existsSync(scenarios) && readdirSync(scenarios).some((file) => file.endsWith(".yaml")),
    `${of}: no conformance scenario in scenarios/${name}/`,
  );
  need(matrix.includes(`\n## ${title}\n`), `${of}: no "## ${title}" section in docs/reality-matrix.md`);
  need(
    existsSync(join(ROOT, `website/docs/platforms/${name}.mdx`)),
    `${of}: no guide, website/docs/platforms/${name}.mdx`,
  );
  need(
    envDocs.includes(`CHANNELSTACK_${upper}_WEBHOOK_URL`),
    `${of}: website/docs/reference/environment-variables.md doesn't name CHANNELSTACK_${upper}_WEBHOOK_URL`,
  );
  need(
    existsSync(join(ROOT, `server/test/integration/${name}-delivery.test.ts`)),
    `${of}: no delivery cases, server/test/integration/${name}-delivery.test.ts`,
  );
  // A platform that publishes a description of its API is held to it; one that doesn't (Notion
  // types its payloads with its SDK instead) has no validator file to register.
  if (existsSync(join(ROOT, `server/test/schemas/${name}.ts`))) {
    need(
      new RegExp(`\\n  ${name}: \\{`).test(read("server/test/schemas/index.ts") ?? ""),
      `${of}: server/test/schemas/${name}.ts isn't registered in server/test/schemas/index.ts (SCHEMAS)`,
    );
  }
  need((read("docs/code-map.md") ?? "").includes(`(${title})`), `${of}: no rows for its driver in docs/code-map.md`);
  if (channel.live) {
    need(
      new RegExp(`\\n  async ${name}\\(`).test(read("scripts/lib/live-agents.ts") ?? ""),
      `${of}: no way to start its reference agent live in scripts/lib/live-agents.ts (LIVE_AGENTS)`,
    );
  }
  for (const variable of [...(channel.live?.credentials ?? []), channel.live?.allowlist].filter(Boolean)) {
    need(live.includes(`${variable}:`), `${of}: .github/workflows/live.yml doesn't pass ${variable} to the live run`);
  }
}
for (const name of HARNESS_CHANNELS) {
  need(
    CHANNELS.some((channel) => channel.name === name),
    `scripts/lib/channels.ts has "${name}", which no driver is`,
  );
}

// --- CI runs every part of the acceptance suite ----------------------------------------------------

const parts = spawnSync(process.execPath, [join(ROOT, "scripts", "accept.ts"), "--parts"], { encoding: "utf8" });
const listed = /part: \[([^\]]*)\]/.exec(read(".github/workflows/ci.yml") ?? "")?.[1];
const ciParts = (listed ?? "").split(",").map((part) => part.trim());
const accepted = JSON.parse(parts.stdout || "[]") as string[];
need(
  JSON.stringify([...ciParts].sort()) === JSON.stringify([...accepted].sort()),
  `.github/workflows/ci.yml runs the acceptance parts [${ciParts.join(", ")}], but scripts/accept.ts has [${accepted.join(", ")}]`,
);

// --- No driver goes around the kit ----------------------------------------------------------------

/** Each file under a folder, recursively, but no tests: they may build what the kit builds, to check it. */
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "schema" ? [] : sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
const BYPASSES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\bdelivery\.(?:enqueue|again|list|get)\(|context\.delivery\b/,
    "calls the delivery queue: use its delivery kit (core/delivery/kit.ts)",
  ],
  [
    /path: "\/(?:deliveries|calls)"/,
    "registers an inspection route: use registerInspectionRoutes (core/router/inspection.ts)",
  ],
  [/super\(\{ platform: code, status: 409 \}, message, data\)/, "repeats LivePlatformRefusal: extend it (core/errors)"],
  [/headers\.get\("retry-after"\)/, "reads Retry-After itself: use waitRetryAfter (core/clock)"],
  [
    /const (?:refTo|pathParam|iso) = |type Awaitable<T> =/,
    "writes a helper core has (refTo, pathParam, iso, Awaitable)",
  ],
];
/**
 * The fakes whose API isn't REST, and so records its calls itself: Slack's Web API is methods
 * posted as forms, Linear's is one GraphQL endpoint. Every REST fake records through restApi.
 */
const NOT_REST: Readonly<Record<string, string>> = {
  slack: "Web API methods, posted as forms",
  linear: "one GraphQL endpoint",
};
for (const file of sources(join(ROOT, "server", "src", "drivers"))) {
  const text = readFileSync(file, "utf8");
  for (const [pattern, says] of BYPASSES) {
    if (pattern.test(text)) problems.push(`${relative(ROOT, file)} ${says}`);
  }
  const driver = relative(join(ROOT, "server", "src", "drivers"), file).split(sep)[0] ?? "";
  if (/\brecordCall\(/.test(text) && !(driver in NOT_REST)) {
    problems.push(`${relative(ROOT, file)} records its calls itself: a REST fake uses restApi (core/fake/endpoint.ts)`);
  }
}
// Core names no platform: each driver declares its ids, secrets and token shapes.
const names = DRIVERS.map((driver) => driver.name).join("|");
for (const file of [
  "server/src/core/ids/formats.ts",
  "server/src/core/secrets/formats.ts",
  "server/src/core/redact/index.ts",
]) {
  const text = read(file) ?? "";
  if (new RegExp(`"(?:${names})\\.\\w+"`).test(text))
    problems.push(`${file} names a platform's format: the driver declares it`);
}

if (problems.length > 0) {
  console.error(`check:channels: ${problems.length} problems\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`check:channels: ${CHANNELS.length} channels, each complete and on the kit`);
