import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { homeDir, writePrivateFile } from "../../server/src/core/home/index.ts";

/** Where the live sandboxes' credentials are kept: `live.env` in channelstack's state directory. */
export const liveEnvPath = (env: NodeJS.ProcessEnv = process.env): string => join(homeDir(env), "live.env");

/** A `NAME=value` line, `export` before it or not, as `set -a; . live.env` reads it. */
const LINE = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/;

/** `live.env`'s variables: a value optionally in single or double quotes; an empty one isn't set. */
export function parseLiveEnv(text: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of text.split("\n")) {
    const found = LINE.exec(line);
    if (!found) continue;
    let value = (found[2] as string).trim();
    if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.at(-1) === value[0])
      value = value.slice(1, -1);
    if (value !== "") env.set(found[1] as string, value);
  }
  return env;
}

/** Set one variable in `live.env`, every other line kept as it is, the file written private (0600) and whole. */
export function setLiveEnv(path: string, name: string, value: string): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const kept = lines.filter((line) => LINE.exec(line)?.[1] !== name);
  while (kept.at(-1) === "") kept.pop();
  writePrivateFile(path, `${[...kept, `${name}=${value}`].join("\n")}\n`);
}
