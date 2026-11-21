#!/usr/bin/env node
// The `channelstack` command: runs the server binary installed for this platform, with the same arguments.
import { spawnSync } from "node:child_process";
import { resolveServerBinary } from "../dist/runtime/launcher.js";

let binary;
try {
  binary = resolveServerBinary();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(`channelstack: could not run ${binary}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
