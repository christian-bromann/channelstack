/**
 * Runs a smoke scenario (docs/decisions/0002-smoke-scenario-format.md) through the TypeScript SDK.
 * Usage: node run.ts <scenario.yaml> [--mode auto|attach|start] [--record <file.json>]
 *
 * `--record` writes what the scenario's `record` steps saved, as plain data: the differential run
 * compares a scenario's recording against the fake with its recording against the real platform.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { ChannelstackError, connect, waitFor } from "channelstack/client";
import { parse } from "yaml";

import { SECRET_FIELD } from "../../../conformance/lib.ts";

interface Check {
  value: unknown;
  equals?: unknown;
  matches?: string;
  contains?: unknown;
}

interface Step {
  call?: string;
  args?: unknown[];
  options?: Record<string, unknown>;
  as?: string;
  until?: Check[];
  throws?: string;
  expect?: Check[];
  /** Save these values, by name, for `--record`. */
  record?: Record<string, unknown>;
}

const [file, ...flags] = process.argv.slice(2);
if (!file) throw new Error("Usage: node run.ts <scenario.yaml> [--mode auto|attach|start]");
const flag = (name: string) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined);
const mode = (flag("--mode") ?? "auto") as "auto" | "attach" | "start";
const recordTo = flag("--record");
const recorded: Record<string, unknown> = {};

/** A value as data: a handle's fields, nothing callable, no secret, nothing twice on one path, a few levels deep. */
function plain(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return typeof value === "function" ? undefined : value;
  if (seen.has(value) || depth > 4) return "<handle>";
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => plain(item, depth + 1, seen))
    : Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !SECRET_FIELD.test(key))
          .map(([key, item]) => [key, plain(item, depth + 1, seen)])
          .filter(([, item]) => item !== undefined),
      );
  seen.delete(value);
  return result;
}
const scenario = parse(readFileSync(file, "utf8")) as { name: string; steps: Step[] };

const variables = new Map<string, unknown>();

/** One step into a value: an array index or `length`, or a property. Missing values read as null. */
function get(target: unknown, key: string): unknown {
  if (target === null || target === undefined) return null;
  return (target as Record<string, unknown>)[key] ?? null;
}

/** `$name.path.to.value` → the saved value; `$$` is a literal `$`; lists and mappings are resolved inside. */
function resolve(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("$$")) return value.slice(1);
    if (!value.startsWith("$")) return value;
    const [name = "", ...path] = value.slice(1).split(".");
    if (!variables.has(name)) throw new Error(`Unknown variable $${name}`);
    return path.reduce(get, variables.get(name));
  }
  if (Array.isArray(value)) return value.map(resolve);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
  return value;
}

/** Does `actual` have everything `expected` asks for? Mappings match partially, everything else exactly. */
function matches(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "object" && expected !== null && !Array.isArray(expected)) {
    return Object.entries(expected).every(([key, value]) => matches(get(actual, key), value));
  }
  return JSON.stringify(actual ?? null) === JSON.stringify(expected ?? null);
}

function failure(check: Check): string | undefined {
  const actual = resolve(check.value);
  const shown = `${JSON.stringify(check.value)} = ${JSON.stringify(actual)}`;
  if ("equals" in check && !matches(actual, resolve(check.equals)))
    return `${shown}, expected ${JSON.stringify(resolve(check.equals))}`;
  if (check.matches !== undefined && !(typeof actual === "string" && new RegExp(check.matches).test(actual))) {
    return `${shown}, expected a match for /${check.matches}/`;
  }
  if ("contains" in check) {
    const wanted = resolve(check.contains);
    if (!(Array.isArray(actual) && actual.some((item) => matches(item, wanted))))
      return `${shown}, expected it to contain ${JSON.stringify(wanted)}`;
  }
  return undefined;
}

function assertAll(checks: Check[], step: number): void {
  const failed = checks.map(failure).find((message) => message !== undefined);
  if (failed) throw new Error(`step ${step}: ${failed}`);
}

async function call(step: Step): Promise<unknown> {
  // `<variable>.<method>`, or a method on a handle inside one: `message.thread.waitForReply`.
  const path = (step.call ?? "").split(".");
  const method = path.pop() ?? "";
  const target = resolve(`$${path.join(".")}`) as Record<string, (...args: unknown[]) => Promise<unknown>> | undefined;
  if (typeof target?.[method] !== "function") throw new Error(`${step.call}: no such method`);
  const args = [...(resolve(step.args ?? []) as unknown[]), ...(step.options ? [resolve(step.options)] : [])];
  return target[method](...args);
}

await using channelstack = await connect({ mode });
await using session = await channelstack.openSession();
variables.set("channelstack", channelstack).set("session", session);

for (const [index, step] of scenario.steps.entries()) {
  const number = index + 1;
  if (step.expect) assertAll(step.expect, number);
  for (const [name, value] of Object.entries(step.record ?? {})) recorded[name] = plain(resolve(value));
  if (!step.call) continue;
  if (step.throws !== undefined) {
    const error = await call(step).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    if (!(error instanceof ChannelstackError) || error.code !== step.throws) {
      throw new Error(
        `step ${number}: ${step.call} should fail with ${step.throws}, got ${error instanceof Error ? error.message : "no error"}`,
      );
    }
    continue;
  }
  const save = async () => {
    const result = await call(step);
    if (step.as) variables.set(step.as, result);
  };
  if (!step.until) {
    await save();
    continue;
  }
  const { until } = step;
  let last: string | undefined;
  await waitFor(`step ${number} (${step.call})`, async () => {
    await save();
    last = until.map(failure).find((message) => message !== undefined);
    return last === undefined ? true : undefined;
  }).catch((error: unknown) => {
    throw new Error(`step ${number}: ${last ?? String(error)}`, { cause: error });
  });
}

if (recordTo) writeFileSync(recordTo, `${JSON.stringify({ scenario: scenario.name, values: recorded }, null, 2)}\n`);
console.log(`ok ${scenario.name} (typescript, ${scenario.steps.length} steps)`);
