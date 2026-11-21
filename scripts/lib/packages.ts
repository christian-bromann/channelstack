import { join } from "node:path";
import { serverBinaryName, serverPackageName } from "../../sdks/typescript/runtime/launcher.ts";
import { ROOT } from "./generate.ts";

/** The five platforms the server is compiled for, keyed like Node's `process.platform`-`process.arch`. */
export const TARGETS = {
  "darwin-arm64": { bun: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
  "darwin-x64": { bun: "bun-darwin-x64", os: "darwin", cpu: "x64" },
  "linux-x64": { bun: "bun-linux-x64", os: "linux", cpu: "x64" },
  "linux-arm64": { bun: "bun-linux-arm64", os: "linux", cpu: "arm64" },
  "win32-x64": { bun: "bun-windows-x64", os: "win32", cpu: "x64" },
} as const;

export type TargetKey = keyof typeof TARGETS;

export function hostTarget(): TargetKey {
  const key = `${process.platform}-${process.arch}`;
  if (!(key in TARGETS)) throw new Error(`channelstack isn't built for ${key}`);
  return key as TargetKey;
}

/** Where the build puts everything that gets published to npm. */
export const NPM_DIR = join(ROOT, "dist", "npm");

/** The directory of a platform package, e.g. `dist/npm/server-darwin-arm64`. */
export function platformPackageDir(key: TargetKey): string {
  return join(NPM_DIR, `server-${key}`);
}

export function platformPackageName(key: TargetKey): string {
  return serverPackageName(TARGETS[key].os, TARGETS[key].cpu);
}

/** The compiled server for a platform, inside its package. */
export function binaryPath(key: TargetKey = hostTarget()): string {
  return join(platformPackageDir(key), "bin", serverBinaryName(TARGETS[key].os));
}
