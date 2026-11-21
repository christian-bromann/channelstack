import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;

/** The state directory: `CHANNELSTACK_HOME`, or `~/.channelstack`. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CHANNELSTACK_HOME || join(homedir(), ".channelstack");
}

/** Write a file only its owner can read (0600, in a 0700 directory), atomically. */
export function writePrivateFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, { mode: PRIVATE_FILE });
  // The mode passed to writeFileSync is masked by the umask and ignored for an existing file.
  chmodSync(temporary, PRIVATE_FILE);
  renameSync(temporary, path);
}

/**
 * Read and parse a private JSON state file. Returns undefined when it doesn't exist. A file that
 * others can read is made private again, and one that isn't JSON is an error that names the file.
 */
export function readPrivateJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) chmodSync(path, PRIVATE_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON. Delete it and start again; channelstack recreates it.`);
  }
}

export function removeFile(path: string): void {
  rmSync(path, { force: true });
}
