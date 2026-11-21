/**
 * Compiles the server into a single binary with `bun build --compile`, one npm package per platform
 * (`@channelstack/server-<platform>`, the esbuild pattern). `--all` builds the five targets; the
 * default builds only this machine's.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const keys = process.argv.includes("--all") ? (Object.keys(TARGETS) as TargetKey[]) : [hostTarget()];

for (const key of keys) {
  const target = TARGETS[key];
  const outfile = binaryPath(key);
  mkdirSync(dirname(outfile), { recursive: true });
  // macOS caches a binary's code signature per file: overwriting one in place gets its next launch killed.
  rmSync(outfile, { force: true });
  const build = spawnSync(
    "bun",
    ["build", "--compile", "--minify", `--target=${target.bun}`, join(ROOT, "server/src/cli.ts"), "--outfile", outfile],
    { cwd: ROOT, stdio: "inherit" },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
  writeFileSync(
    join(platformPackageDir(key), "package.json"),
    toJson({
      name: platformPackageName(key),
      version: serverPackage.version,
      description: `The channelstack server binary for ${key}.`,
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/christian-bromann/channelstack.git" },
      os: [target.os],
      cpu: [target.cpu],
      files: ["bin"],
    }),
  );
  console.log(`built ${platformPackageName(key)} → ${outfile}`);
}
