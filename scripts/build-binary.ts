/**
 * Compiles the server into a single binary with `bun build --compile`, one npm package per platform
 * (`@channelstack/server-<platform>`, the esbuild pattern). `--all` builds the five targets,
 * `--target <key>` one of them; the default builds only this machine's.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import serverPackage from "../server/package.json" with { type: "json" };
import { ROOT, toJson } from "./lib/generate.ts";
import {
  binaryPath,
  hostTarget,
  platformPackageDir,
  platformPackageName,
  type TargetKey,
  TARGETS,
} from "./lib/packages.ts";

/** The targets to build: `--all`, one `--target <key>` (the release builds each on its own runner), or this machine's. */
function targets(): TargetKey[] {
  if (process.argv.includes("--all")) return Object.keys(TARGETS) as TargetKey[];
  const at = process.argv.indexOf("--target");
  if (at === -1) return [hostTarget()];
  const key = process.argv[at + 1] ?? "";
  if (!(key in TARGETS)) throw new Error(`--target is one of ${Object.keys(TARGETS).join(", ")}, not "${key}"`);
  return [key as TargetKey];
}

const keys = targets();

for (const key of keys) {
  const target = TARGETS[key];
  const outfile = binaryPath(key);
  mkdirSync(dirname(outfile), { recursive: true });
  // macOS caches a binary's code signature per file: overwriting one in place gets its next launch killed.
  rmSync(outfile, { force: true });
  // `bun build --compile`, with a plugin that makes WebdriverIO bundle (scripts/bun-compile.ts).
  const build = spawnSync(
    "bun",
    [join(ROOT, "scripts/bun-compile.ts"), join(ROOT, "server/src/cli.ts"), target.bun, outfile],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
  writeFileSync(
    join(platformPackageDir(key), "package.json"),
    toJson({
      name: platformPackageName(key),
      version: serverPackage.version,
      description: `The channelstack server binary for ${key}. Installed with the channelstack package; not meant to be used on its own.`,
      license: "MIT",
      homepage: "https://channelstack.dev",
      repository: { type: "git", url: "git+https://github.com/christian-bromann/channelstack.git" },
      os: [target.os],
      cpu: [target.cpu],
      files: ["bin"],
    }),
  );
  // What npm shows for the package, and the license it is published under.
  copyFileSync(join(ROOT, "LICENSE"), join(platformPackageDir(key), "LICENSE"));
  writeFileSync(
    join(platformPackageDir(key), "README.md"),
    `# ${platformPackageName(key)}\n\nThe [channelstack](https://www.npmjs.com/package/channelstack) server, compiled for ${key}. npm installs it with \`channelstack\`, as an optional dependency for this platform: install \`channelstack\` instead.\n`,
  );
  console.log(`built ${platformPackageName(key)} → ${outfile}`);
}
