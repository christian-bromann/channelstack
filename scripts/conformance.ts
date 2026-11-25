/**
 * `pnpm conformance [--channel <name>] [--fake-only] [--out <file>] [--bin <server>]`: the
 * differential run (implementation plan 9.1, exit check 6.4). Each scenario in
 * `scenarios/<channel>/` runs through the TypeScript SDK against the fake with the channel's
 * reference agent, and, for every channel whose live credentials are set, against the sandbox with
 * the same agent (`lib/live-stack.ts`). The two recordings are normalized and compared; a difference
 * fails the run unless `conformance/divergences.yaml` allows it with a reason and a date that hasn't
 * passed. The results go to `--out` (default `build/conformance/results.json`), which the coverage
 * page reads.
 *
 * CI runs `--fake-only` on every pull request, so a scenario is known to pass against the fake;
 * the nightly job runs it in full.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import {
  classify,
  type ConformanceResults,
  diff,
  expired,
  loadDivergences,
  normalize,
  type ScenarioResult,
  type ShapeResult,
} from "../conformance/lib.ts";
import { compareShapes, readShapes } from "../conformance/shapes.ts";
import { SECRET_FIELD } from "../scenarios/runners/typescript/secrets.ts";
import { DRIVERS } from "../server/src/drivers/index.ts";
import { AGENTS } from "./examples.ts";
import { ROOT } from "./lib/generate.ts";
import { withLiveStack } from "./lib/live-stack.ts";
import { binaryPath } from "./lib/packages.ts";
import { runAsync } from "./lib/process.ts";
import { withStack } from "./lib/stack.ts";

/** Each channel's reference agent, the same one fake and live. */
const REFERENCE = { slack: "bolt-ai-sdk", github: "probot", linear: "linear-sdk", notion: "notion-sdk" } as const;
type Channel = keyof typeof REFERENCE;
const CHANNELS = Object.keys(REFERENCE) as Channel[];

const { values } = parseArgs({
  options: {
    channel: { type: "string" },
    "fake-only": { type: "boolean" },
    out: { type: "string" },
    bin: { type: "string" },
  },
});
const bin = values.bin ?? process.env.CHANNELSTACK_SERVER_BIN ?? binaryPath();
if (!existsSync(bin)) throw new Error(`No server binary at ${bin}. Run \`pnpm build\` first.`);
const out = values.out ?? join(ROOT, "build", "conformance", "results.json");
const channels = values.channel ? [values.channel as Channel] : CHANNELS;
if (channels.some((channel) => !CHANNELS.includes(channel))) {
  throw new Error(`--channel takes one of ${CHANNELS.join(", ")}, got "${values.channel}"`);
}

const today = new Date().toISOString().slice(0, 10);
const divergences = loadDivergences(join(ROOT, "conformance", "divergences.yaml"));
const work = mkdtempSync(join(tmpdir(), "channelstack-conformance-"));
const runner = join(ROOT, "scenarios", "runners", "typescript", "run.ts");
const scenariosOf = (channel: Channel) => {
  const dir = join(ROOT, "scenarios", channel);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => file.endsWith(".yaml"))
        .sort()
        .map((file) => join(dir, file))
    : [];
};
const recording = (side: "fake" | "live", file: string) =>
  join(work, `${side}-${file.slice(ROOT.length + 1).replaceAll("/", "_")}.json`);

/** A key anywhere in a value that names a secret field. */
const secretKey = (value: unknown, path = ""): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  for (const [key, item] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (SECRET_FIELD.test(key)) return at;
    const found = secretKey(item, at);
    if (found) return found;
  }
  return undefined;
};

/** What is wrong with a recording the runner wrote: it must be private and hold no secret field. */
function recordingProblem(file: string): string | undefined {
  if ((statSync(file).mode & 0o077) !== 0) return `the recording ${file} can be read by others`;
  const found = secretKey(JSON.parse(readFileSync(file, "utf8")));
  return found ? `the recording holds a secret field (${found})` : undefined;
}

/** Run one scenario attached to a server, recording it. Answers an error's message, or nothing when it passed. */
async function record(file: string, side: "fake" | "live", env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    await runAsync(process.execPath, [runner, file, "--mode", "attach", "--record", recording(side, file)], {
      cwd: ROOT,
      env,
    });
    return recordingProblem(recording(side, file));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const results = new Map<string, ScenarioResult>();
try {
  // Against the fake: one server and the channel's reference agent per channel.
  for (const channel of channels) {
    const files = scenariosOf(channel);
    if (files.length === 0) continue;
    const name = REFERENCE[channel];
    const agent = join(ROOT, "examples", "agents", name, "agent.ts");
    // The fake half is fake whatever credentials are in the environment.
    const fake = { CHANNELSTACK_REALITY: "fake" };
    // In proxy mode with the recorder: the agent calls the platform's own hosts, and every
    // exchange and webhook is written as its shape for the shape differ.
    await withStack(
      {
        bin,
        agent,
        webhook: { driver: channel, path: AGENTS[name].path },
        serverEnv: fake,
        proxy: true,
        record: join(work, `fake-${channel}`),
      },
      async ({ env }) => {
        for (const file of files) {
          const failed = await record(file, "fake", { ...env, ...fake });
          results.set(file, {
            scenario: file.slice(join(ROOT, "scenarios").length + 1).replace(/\.yaml$/, ""),
            channel,
            fake: failed ? "failed" : "passed",
            live: "skipped",
            ...(failed ? { note: `fake: ${failed}` } : {}),
            differences: [],
          });
        }
      },
    );
  }

  // Against the sandboxes: the channels whose credentials are set, one live server with every agent.
  const liveChannels: string[] = values["fake-only"]
    ? []
    : channels.filter((channel) => {
        const credentials = DRIVERS.find((driver) => driver.name === channel)?.live?.credentials ?? [];
        return credentials.length > 0 && credentials.every((variable) => process.env[variable]);
      });
  for (const result of results.values()) {
    if (!liveChannels.includes(result.channel)) {
      result.note ??= values["fake-only"] ? "live: --fake-only" : `live: ${result.channel}'s credentials aren't set`;
    }
  }
  let liveOk = true;
  if (liveChannels.length > 0) {
    liveOk = await withLiveStack({ bin, env: process.env, record: join(work, "live") }, async ({ env }) => {
      for (const [file, result] of results) {
        if (!liveChannels.includes(result.channel)) continue;
        const failed = await record(file, "live", env);
        result.live = failed ? "failed" : "passed";
        if (failed) result.note = `live: ${failed}`;
        if (result.fake !== "passed" || failed) continue;
        const read = (side: "fake" | "live") =>
          normalize((JSON.parse(readFileSync(recording(side, file), "utf8")) as { values: unknown }).values);
        result.recordings = { fake: read("fake"), live: read("live") };
        result.differences = classify(
          result.scenario,
          diff(result.recordings.fake, result.recordings.live),
          divergences,
          today,
        );
      }
    });
  }

  // The shape differ: each operation both sides saw, the fake's shape against the platform's.
  const liveShapes = readShapes([join(work, "live", "shapes.jsonl"), join(work, "live", "relay", "shapes.jsonl")]);
  const shapes: ShapeResult[] = liveChannels.flatMap((channel) => {
    const fakeShapes = readShapes([join(work, `fake-${channel}`, "shapes.jsonl")]);
    return [...fakeShapes].flatMap(([key, fakeShape]) => {
      const [kind = "", owner = "", ...operation] = key.split(" ");
      const liveShape = liveShapes.get(key);
      if (owner !== channel || liveShape === undefined) return [];
      const differences = compareShapes(fakeShape, liveShape).map((difference) => ({
        ...difference,
        path: `${kind} ${operation.join(" ")} ${difference.path}`,
      }));
      return [
        {
          channel,
          kind: kind as "api" | "webhook",
          operation: operation.join(" "),
          differences: classify(`shapes/${channel}`, differences, divergences, today),
        },
      ];
    });
  });

  const report: ConformanceResults = {
    at: new Date().toISOString(),
    live: liveChannels.length > 0,
    shapes,
    scenarios: [...results.values()],
    expired: expired(divergences, today),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

  // A channel whose scenarios passed live sent webhooks; none recorded means the tap or relay
  // recording them stopped working, and the shape differ would compare nothing for it, quietly.
  const unrecorded = liveChannels.filter(
    (channel) =>
      report.scenarios.some((result) => result.channel === channel && result.live === "passed") &&
      ![...liveShapes.keys()].some((key) => key.startsWith(`webhook ${channel} `)),
  );

  // What fails the run: a scenario that failed either way, a difference nothing allows, an expired divergence, leftovers.
  const problems = [
    ...unrecorded.map(
      (channel) => `shapes/${channel}: its scenarios passed live, but none of its webhooks was recorded live`,
    ),
    ...report.scenarios
      .filter((result) => result.fake === "failed")
      .map((result) => `${result.scenario}: ${result.note}`),
    ...report.scenarios
      .filter((result) => result.live === "failed")
      .map((result) => `${result.scenario}: ${result.note}`),
    ...report.scenarios.flatMap((result) =>
      result.differences
        .filter((difference) => !difference.allowedBy)
        .map(
          (difference) =>
            `${result.scenario}: ${difference.path} is ${JSON.stringify(difference.fake)} in the fake and ${JSON.stringify(difference.live)} live`,
        ),
    ),
    ...report.shapes.flatMap((result) =>
      result.differences
        .filter((difference) => !difference.allowedBy)
        .map(
          (difference) =>
            `shapes/${result.channel}: ${difference.path} is ${JSON.stringify(difference.fake ?? "missing")} in the fake and ${JSON.stringify(difference.live)} live`,
        ),
    ),
    ...report.expired.map(
      (divergence) => `divergences.yaml: ${divergence.scenario} ${divergence.path} expired on ${divergence.expires}`,
    ),
    ...(liveOk ? [] : ["the live run failed or left something behind (above)"]),
  ];
  for (const result of report.scenarios) {
    const allowed = result.differences.filter((difference) => difference.allowedBy).length;
    console.log(
      `${result.scenario}: fake ${result.fake}, live ${result.live}${result.live === "passed" ? `, ${result.differences.length - allowed} differences, ${allowed} allowed` : ""}`,
    );
  }
  const compared = report.shapes.length;
  const differing = report.shapes.filter((result) =>
    result.differences.some((difference) => !difference.allowedBy),
  ).length;
  if (report.live) console.log(`shapes: ${compared} operations seen both ways, ${differing} with differences`);
  console.log(`\nconformance: results in ${out}`);
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} problem${problems.length === 1 ? "" : "s"}:\n${problems.map((problem) => `  ${problem}`).join("\n")}`,
    );
    process.exitCode = 1;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
