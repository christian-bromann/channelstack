/**
 * Exit check 0.4: the stale checks catch drift. Changes the working tree the way a forgetful
 * change would, checks that `spec:check` and `sdk:check` fail, and puts everything back.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/generate.ts";

const ROUTES = "server/src/drivers/echo/routes.ts";
const GENERATED_TS = "sdks/typescript/generated/index.ts";
const STRAY = "sdks/python/channelstack/generated/stray.py";

const passes = (script: "spec" | "sdk") =>
  spawnSync(process.execPath, [join(ROOT, "scripts", `${script}.ts`), "--check"], { cwd: ROOT, stdio: "ignore" })
    .status === 0;

function expect(
  what: string,
  actual: { spec: boolean; sdk: boolean },
  expected: { spec: boolean; sdk: boolean },
): void {
  const verdict = (ok: boolean) => (ok ? "pass" : "fail");
  const verb = (ok: boolean) => (ok ? "passes" : "fails");
  if (actual.spec !== expected.spec || actual.sdk !== expected.sdk) {
    throw new Error(
      `${what}: expected spec:check to ${verdict(expected.spec)} and sdk:check to ${verdict(expected.sdk)}, ` +
        `got ${verdict(actual.spec)} and ${verdict(actual.sdk)}`,
    );
  }
  console.log(`ok ${what}: spec:check ${verb(actual.spec)}, sdk:check ${verb(actual.sdk)}`);
}

/** Apply a change to the working tree, look at both checks, and undo the change whatever happens. */
function withChange(what: string, apply: () => () => void, expected: { spec: boolean; sdk: boolean }): void {
  const undo = apply();
  try {
    expect(what, { spec: passes("spec"), sdk: passes("sdk") }, expected);
  } finally {
    undo();
  }
}

function edit(path: string, from: string, to: string): () => void {
  const file = join(ROOT, path);
  const original = readFileSync(file, "utf8");
  if (!original.includes(from))
    throw new Error(`${path} no longer contains ${JSON.stringify(from)}; update this self-test`);
  writeFileSync(file, original.replace(from, to));
  return () => writeFileSync(file, original);
}

expect("a clean tree", { spec: passes("spec"), sdk: passes("sdk") }, { spec: true, sdk: true });

withChange("a route renamed without regenerating", () => edit(ROUTES, 'name: "say"', 'name: "speak"'), {
  spec: false,
  sdk: false,
});

withChange(
  "a body field added without regenerating",
  () =>
    edit(
      ROUTES,
      "body: z.object({ name: z.string().min(1) })",
      "body: z.object({ name: z.string().min(1), title: z.string().optional() })",
    ),
  // The IR builder refuses a body field no SDK method exposes, so both checks fail.
  { spec: false, sdk: false },
);

withChange("generated code edited by hand", () => edit(GENERATED_TS, "export const VERSION", "export const  VERSION"), {
  spec: true,
  sdk: false,
});

withChange(
  "a hand-written file in a generated folder",
  () => {
    writeFileSync(join(ROOT, STRAY), "# not generated\n");
    return () => rmSync(join(ROOT, STRAY));
  },
  { spec: true, sdk: false },
);

expect("the tree after the self-test", { spec: passes("spec"), sdk: passes("sdk") }, { spec: true, sdk: true });
