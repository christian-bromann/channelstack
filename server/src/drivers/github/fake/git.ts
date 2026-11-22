import { structuredPatch } from "diff";
import git from "isomorphic-git";
import { createFsFromVolume, Volume } from "memfs";

import type { GitHubCommitInfo, GitHubFileChange } from "../world.ts";

/** A file in a tree: its blob and mode. */
export interface GitFile {
  sha: string;
  mode: string;
}

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

interface Signature {
  name: string;
  email: string;
  /** Milliseconds since the epoch. */
  date: number;
}

/** The mode git gives an ordinary file, and a directory. */
export const FILE_MODE = "100644";
export const TREE_MODE = "040000";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The text of a blob, or nothing when it isn't text (GitHub shows no patch for a binary file). */
function text(bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/** One side of a hunk header as git writes it: an empty side starts one line lower, and a count of 1 is left out. */
const range = (start: number, count: number): string =>
  count === 0 ? `${start - 1},0` : count === 1 ? String(start) : `${start},${count}`;

const signature = (who: Signature) => ({
  name: who.name,
  email: who.email,
  timestamp: Math.floor(who.date / 1000),
  timezoneOffset: 0,
});

/**
 * Git for the fake's repositories: real objects with real SHAs, kept in memory. Every repository
 * is a bare-like directory in one in-memory filesystem; isomorphic-git does the object work.
 */
export class GitStore {
  // isomorphic-git takes any `fs`; memfs is one that lives in memory.
  #fs = createFsFromVolume(new Volume());

  #repo(dir: string) {
    return { fs: this.#fs, dir };
  }

  async init(dir: string, defaultBranch: string): Promise<void> {
    await git.init({ ...this.#repo(dir), defaultBranch });
  }

  /** Forget a repository, when the session that owned it closes. */
  remove(dir: string): void {
    this.#fs.rmSync(dir, { recursive: true, force: true });
  }

  /** Forget every repository (`POST /reset`). */
  clear(): void {
    this.#fs = createFsFromVolume(new Volume());
  }

  writeBlob(dir: string, content: Uint8Array | string): Promise<string> {
    return git.writeBlob({ ...this.#repo(dir), blob: typeof content === "string" ? encoder.encode(content) : content });
  }

  async readBlob(dir: string, sha: string): Promise<Uint8Array | undefined> {
    try {
      return (await git.readBlob({ ...this.#repo(dir), oid: sha })).blob;
    } catch {
      return undefined;
    }
  }

  writeTree(dir: string, entries: readonly GitTreeEntry[]): Promise<string> {
    return git.writeTree({
      ...this.#repo(dir),
      tree: entries.map((entry) => ({ mode: entry.mode, path: entry.path, oid: entry.sha, type: entry.type })),
    });
  }

  /** The entries of one tree, not its subtrees. Undefined when there is no such tree. */
  async readTree(dir: string, sha: string): Promise<GitTreeEntry[] | undefined> {
    try {
      const { tree } = await git.readTree({ ...this.#repo(dir), oid: sha });
      return tree.map((entry) => ({ path: entry.path, mode: entry.mode, type: entry.type, sha: entry.oid }));
    } catch {
      return undefined;
    }
  }

  writeCommit(
    dir: string,
    commit: { message: string; tree: string; parents: readonly string[]; author: Signature; committer: Signature },
  ): Promise<string> {
    return git.writeCommit({
      ...this.#repo(dir),
      commit: {
        message: commit.message,
        tree: commit.tree,
        parent: [...commit.parents],
        author: signature(commit.author),
        committer: signature(commit.committer),
      },
    });
  }

  async readCommit(dir: string, sha: string): Promise<GitHubCommitInfo | undefined> {
    try {
      const { oid, commit } = await git.readCommit({ ...this.#repo(dir), oid: sha });
      const who = (person: { name: string; email: string; timestamp: number }) => ({
        name: person.name,
        email: person.email,
        date: person.timestamp * 1000,
      });
      return {
        sha: oid,
        tree: commit.tree,
        parents: commit.parent,
        // git ends a message with a newline; GitHub shows it without.
        message: commit.message.replace(/\n$/, ""),
        author: who(commit.author),
        committer: who(commit.committer),
      };
    } catch {
      return undefined;
    }
  }

  /** What a branch points at. */
  async branch(dir: string, name: string): Promise<string | undefined> {
    try {
      return await git.resolveRef({ ...this.#repo(dir), ref: `refs/heads/${name}` });
    } catch {
      return undefined;
    }
  }

  async setBranch(dir: string, name: string, sha: string): Promise<void> {
    await git.writeRef({ ...this.#repo(dir), ref: `refs/heads/${name}`, value: sha, force: true });
  }

  async deleteBranch(dir: string, name: string): Promise<void> {
    await git.deleteRef({ ...this.#repo(dir), ref: `refs/heads/${name}` });
  }

  branches(dir: string): Promise<string[]> {
    return git.listBranches(this.#repo(dir));
  }

  /** A commit by its SHA, or what a branch points at. */
  async resolve(dir: string, ref: string): Promise<string | undefined> {
    const name = ref.replace(/^refs\/heads\//, "").replace(/^heads\//, "");
    const branch = await this.branch(dir, name);
    if (branch) return branch;
    return /^[0-9a-f]{40}$/.test(ref) && (await this.readCommit(dir, ref)) ? ref : undefined;
  }

  /** The history of a commit, newest first. */
  async log(dir: string, sha: string, depth?: number): Promise<GitHubCommitInfo[]> {
    const seen = new Set<string>();
    const out: GitHubCommitInfo[] = [];
    const queue = [sha];
    while (queue.length > 0 && (depth === undefined || out.length < depth)) {
      const next = queue.shift();
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      const commit = await this.readCommit(dir, next);
      if (!commit) continue;
      out.push(commit);
      queue.push(...commit.parents);
    }
    return out;
  }

  /** The commits on `head` that aren't on `base`, oldest first. */
  async ahead(dir: string, base: string, head: string): Promise<GitHubCommitInfo[]> {
    const behind = new Set((await this.log(dir, base)).map((commit) => commit.sha));
    return (await this.log(dir, head)).filter((commit) => !behind.has(commit.sha)).reverse();
  }

  /** The newest commit both histories share. */
  async mergeBase(dir: string, a: string, b: string): Promise<string | undefined> {
    const mine = new Set((await this.log(dir, a)).map((commit) => commit.sha));
    return (await this.log(dir, b)).find((commit) => mine.has(commit.sha))?.sha;
  }

  /** Every file of a commit (or of a tree), by path. */
  async files(dir: string, treeish: string): Promise<Map<string, GitFile>> {
    const commit = await this.readCommit(dir, treeish);
    const out = new Map<string, GitFile>();
    const walk = async (sha: string, prefix: string): Promise<void> => {
      for (const entry of (await this.readTree(dir, sha)) ?? []) {
        const path = `${prefix}${entry.path}`;
        if (entry.type === "tree") await walk(entry.sha, `${path}/`);
        else out.set(path, { sha: entry.sha, mode: entry.mode });
      }
    };
    await walk(commit?.tree ?? treeish, "");
    return out;
  }

  /** Write the trees for a set of files and answer with the root tree. */
  async treeOf(dir: string, files: ReadonlyMap<string, GitFile>): Promise<string> {
    const build = async (prefix: string): Promise<string> => {
      const entries = new Map<string, GitTreeEntry>();
      for (const [path, file] of files) {
        if (!path.startsWith(prefix)) continue;
        const [name = "", ...rest] = path.slice(prefix.length).split("/");
        if (rest.length === 0) entries.set(name, { path: name, mode: file.mode, type: "blob", sha: file.sha });
        else if (!entries.has(name)) {
          entries.set(name, { path: name, mode: TREE_MODE, type: "tree", sha: await build(`${prefix}${name}/`) });
        }
      }
      return this.writeTree(dir, [...entries.values()]);
    };
    return build("");
  }

  /** Commit a set of changes on top of a parent (or as a first commit). `null` deletes a file. */
  async commitChanges(
    dir: string,
    options: {
      parent: string | undefined;
      changes: ReadonlyMap<string, Uint8Array | string | null>;
      message: string;
      author: Signature;
    },
  ): Promise<string> {
    const files = options.parent ? await this.files(dir, options.parent) : new Map<string, GitFile>();
    for (const [path, content] of options.changes) {
      if (content === null) files.delete(path);
      else files.set(path, { sha: await this.writeBlob(dir, content), mode: files.get(path)?.mode ?? FILE_MODE });
    }
    return this.writeCommit(dir, {
      message: options.message,
      tree: await this.treeOf(dir, files),
      parents: options.parent ? [options.parent] : [],
      author: options.author,
      committer: options.author,
    });
  }

  /**
   * The files of merging `theirs` into `ours`, given what they both started from. Undefined when
   * both sides changed the same file differently: a conflict the fake doesn't resolve.
   */
  async merged(dir: string, base: string, ours: string, theirs: string): Promise<Map<string, GitFile> | undefined> {
    const [start, mine, other] = await Promise.all([
      this.files(dir, base),
      this.files(dir, ours),
      this.files(dir, theirs),
    ]);
    const result = new Map(mine);
    for (const path of new Set([...start.keys(), ...other.keys()])) {
      const [was, here, there] = [start.get(path)?.sha, mine.get(path)?.sha, other.get(path)?.sha];
      if (there === was || there === here) continue;
      if (here !== was) return undefined;
      const file = other.get(path);
      if (file) result.set(path, file);
      else result.delete(path);
    }
    return result;
  }

  /** What changed between two commits, with patches. Without `from`, everything in `to` is new. */
  async changes(dir: string, from: string | undefined, to: string): Promise<GitHubFileChange[]> {
    const [before, after] = await Promise.all([
      from ? this.files(dir, from) : Promise.resolve(new Map<string, GitFile>()),
      this.files(dir, to),
    ]);
    const out: GitHubFileChange[] = [];
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const [was, now] = [before.get(path), after.get(path)];
      if (was?.sha === now?.sha) continue;
      const [oldText, newText] = await Promise.all([
        was ? this.readBlob(dir, was.sha).then((bytes) => (bytes ? text(bytes) : undefined)) : "",
        now ? this.readBlob(dir, now.sha).then((bytes) => (bytes ? text(bytes) : undefined)) : "",
      ]);
      const change: GitHubFileChange = {
        path,
        status: was === undefined ? "added" : now === undefined ? "removed" : "modified",
        sha: (now ?? was)?.sha ?? "",
        additions: 0,
        deletions: 0,
        patch: undefined,
        rightLines: [],
        leftLines: [],
      };
      if (oldText !== undefined && newText !== undefined) {
        const { hunks } = structuredPatch(path, path, oldText, newText, "", "", { context: 3 });
        const lines: string[] = [];
        for (const hunk of hunks) {
          lines.push(`@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`);
          let [left, right] = [hunk.oldStart, hunk.newStart];
          for (const line of hunk.lines) {
            lines.push(line);
            if (line.startsWith("+")) {
              change.additions++;
              change.rightLines.push(right++);
            } else if (line.startsWith("-")) {
              change.deletions++;
              change.leftLines.push(left++);
            } else if (line.startsWith(" ")) {
              // A context line can be commented on from either side.
              change.leftLines.push(left++);
              change.rightLines.push(right++);
            }
          }
        }
        change.patch = lines.join("\n");
      }
      out.push(change);
    }
    return out;
  }
}
