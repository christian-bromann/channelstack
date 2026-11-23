import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Files in a test: inline contents, or a path to a fixture file or directory (`api/common.d.ts`). */
export type FileInput =
  { name: string; content: string | Uint8Array; mimeType?: string } | { path: string; name?: string };

/** A file as it travels to the server: where it goes, and its bytes in base64. */
interface WireFile {
  path: string;
  content: string;
}

let root: string | undefined;

/**
 * Where relative fixture paths start from. A test framework integration sets it to the directory
 * of the test file, so `files: "./fixtures/web"` means what it means in an import. Without it,
 * paths start from the working directory.
 */
export function setFilesRoot(directory: string | undefined): void {
  root = directory;
}

const located = (path: string): string => (isAbsolute(path) ? path : resolve(root ?? process.cwd(), path));
const base64 = (content: string | Uint8Array): string => Buffer.from(content).toString("base64");

/** Every file under a directory, by its path inside it, with forward slashes. */
function walk(directory: string): WireFile[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((file) => ({ path: relative(directory, file).split(sep).join("/"), content: base64(readFileSync(file)) }));
}

/** One file input as wire files: inline contents, a file on disk, or everything under a directory on disk. */
function read(input: FileInput): WireFile[] {
  if ("content" in input) return [{ path: input.name, content: base64(input.content) }];
  const path = located(input.path);
  if (statSync(path).isDirectory()) {
    return walk(path).map((file) => ({ ...file, path: input.name ? `${input.name}/${file.path}` : file.path }));
  }
  return [{ path: input.name ?? input.path.split(/[\\/]/).at(-1) ?? input.path, content: base64(readFileSync(path)) }];
}

/** A whole tree of files: a fixture directory, or a list of files. */
export function readTree(input: string | FileInput[]): WireFile[] {
  return typeof input === "string" ? walk(located(input)) : input.flatMap(read);
}

/** Changes to files: a list of files, or a map of path to its new contents, where `null` deletes the file. */
export function readChanges(
  input: FileInput[] | Record<string, string | null>,
): Array<{ path: string; content: string | null }> {
  if (Array.isArray(input)) return input.flatMap(read);
  return Object.entries(input).map(([path, content]) => ({ path, content: content === null ? null : base64(content) }));
}

/** One text a test hands over: inline, or the contents of a fixture file (`{ path }`). Structured content passes as it is. */
export function readDocument(input: string | { path: string } | unknown[]): string | unknown[] {
  return typeof input === "string" || Array.isArray(input) ? input : readFileSync(located(input.path), "utf8");
}
