#!/usr/bin/env node
// The `channelstack` command: runs the server binary installed for this platform, with the same arguments.
import { spawn } from "node:child_process";
import { resolveServerBinary } from "../dist/runtime/launcher.js";

let binary;
try {
  binary = resolveServerBinary();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

// Stopping this wrapper must stop the server, so it can remove its token file and its *.localhost names.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`channelstack: could not run ${binary}: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  // End the way the server did, so a caller sees its exit code or the signal that stopped it.
  if (!signal) process.exit(code ?? 1);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});
