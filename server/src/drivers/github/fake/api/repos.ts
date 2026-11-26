import { githubNodeId } from "../../ids.ts";
import { type GitHubCommitInfo, PERMISSIONS } from "../../world.ts";
import { FILE_MODE, type GitTreeEntry, TREE_MODE } from "../git.ts";
import { GitHubRefusal } from "../kit.ts";
import { type Call, invalid, type Json, notFound, page, type Register, text, time } from "./shared.ts";

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** Repositories, their contents and the Git Data API. */
export function registerRepos(register: Register): void {
  const contents = ["contents", "read"] as const;
  const write = ["contents", "write"] as const;

  const dirOf = ({ world, repo }: Call) => world.kit.dir(repo);
  const commitOf = async (call: Call, ref: string): Promise<GitHubCommitInfo> => {
    const { git } = call.world.kit;
    const sha = await git.resolve(dirOf(call), ref);
    const info = sha ? await git.readCommit(dirOf(call), sha) : undefined;
    if (!info) throw new GitHubRefusal(422, `No commit found for SHA: ${ref}`);
    return info;
  };
  const commitJson = async (call: Call, info: GitHubCommitInfo, detailed: boolean): Promise<Json> => {
    const { world, repo } = call;
    const who = world.repos.commitAuthor(repo, info);
    const changes = detailed ? await world.kit.git.changes(dirOf(call), info.parents[0], info.sha) : undefined;
    return world.kit.objects.commit(repo, info, { author: who, committer: who }, changes);
  };
  /**
   * The rest of a route's path: a ref or a file path with slashes in it. It starts right after
   * `/repos/{owner}/{repo}` and the route's own segment, so a path that names that segment again
   * (`contents/docs/contents/x.md`) is taken whole.
   */
  const rest = ({ c }: Call, after: string): string => {
    const tail = c.req.path.replace(/^.*?\/repos\/[^/]+\/[^/]+/, "").slice(after.length);
    try {
      return decodeURIComponent(tail);
    } catch {
      // A percent escape that isn't one names nothing.
      throw notFound();
    }
  };

  register("get", "", ["metadata", "read"], ({ c, world, repo }) => c.json(world.kit.objects.fullRepository(repo)));

  register("get", "/collaborators/:user/permission", ["metadata", "read"], ({ c, world, repo }) => {
    const user = world.kit.store.byLogin(world.kit.store.sessionOf(repo), c.req.param("user") ?? "");
    if (!user) throw notFound();
    const level = PERMISSIONS.toReversed().find((candidate) => world.kit.can(repo, user.id, candidate));
    // The API's older names: write is still "write", but triage and maintain show as read and write.
    const permission =
      level === "admin" ? "admin" : level === "write" || level === "maintain" ? "write" : level ? "read" : "none";
    return c.json({
      permission,
      role_name: level ?? "none",
      user: world.kit.objects.collaborator(user, level ?? "none"),
    });
  });

  // --- Branches and commits ------------------------------------------------------------------

  const branch = async (call: Call, name: string): Promise<Json> => {
    const info = await commitOf(call, name);
    return {
      name,
      commit: await commitJson(call, info, false),
      _links: {
        html: `${call.world.kit.objects.repoWeb(call.repo)}/tree/${name}`,
        self: `${call.world.kit.objects.repoApi(call.repo)}/branches/${name}`,
      },
      protected: false,
      protection: { enabled: false, required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } },
      protection_url: `${call.world.kit.objects.repoApi(call.repo)}/branches/${name}/protection`,
    };
  };

  register("get", "/branches", contents, async (call) => {
    const { c, world, repo } = call;
    const names = await world.kit.git.branches(dirOf(call));
    const out = await Promise.all(
      names.map(async (name) => {
        const sha = (await world.kit.git.branch(dirOf(call), name)) ?? "";
        return { name, commit: { sha, url: `${world.kit.objects.repoApi(repo)}/commits/${sha}` }, protected: false };
      }),
    );
    return c.json(page(c, out));
  });

  register("get", "/branches/*", contents, async (call) => {
    const name = rest(call, "/branches/");
    if (!(await call.world.kit.git.branch(dirOf(call), name))) throw new GitHubRefusal(404, "Branch not found");
    return call.c.json(await branch(call, name));
  });

  register("get", "/commits", contents, async (call) => {
    const { c, world, repo } = call;
    const from = await commitOf(call, c.req.query("sha") ?? repo.defaultBranch);
    const history = await world.kit.git.log(dirOf(call), from.sha);
    return c.json(await Promise.all(page(c, history).map((info) => commitJson(call, info, false))));
  });

  register("get", "/compare/*", contents, async (call) => {
    const { c, world, repo } = call;
    const [from, to] = rest(call, "/compare/").split("...");
    if (!from || !to) throw notFound();
    const [base, head] = await Promise.all([commitOf(call, from), commitOf(call, to)]);
    const dir = dirOf(call);
    const start = (await world.kit.git.mergeBase(dir, base.sha, head.sha)) ?? base.sha;
    const [ahead, behind, changes, merge] = await Promise.all([
      world.kit.git.ahead(dir, base.sha, head.sha),
      world.kit.git.ahead(dir, head.sha, base.sha),
      world.kit.git.changes(dir, start, head.sha),
      commitOf(call, start),
    ]);
    const web = world.kit.objects.repoWeb(repo);
    return c.json({
      url: `${world.kit.objects.repoApi(repo)}/compare/${from}...${to}`,
      html_url: `${web}/compare/${from}...${to}`,
      permalink_url: `${web}/compare/${repo.owner}:${base.sha.slice(0, 7)}...${repo.owner}:${head.sha.slice(0, 7)}`,
      diff_url: `${web}/compare/${from}...${to}.diff`,
      patch_url: `${web}/compare/${from}...${to}.patch`,
      base_commit: await commitJson(call, base, false),
      merge_base_commit: await commitJson(call, merge, false),
      status:
        ahead.length > 0 && behind.length > 0
          ? "diverged"
          : ahead.length > 0
            ? "ahead"
            : behind.length > 0
              ? "behind"
              : "identical",
      ahead_by: ahead.length,
      behind_by: behind.length,
      total_commits: ahead.length,
      commits: await Promise.all(ahead.map((info) => commitJson(call, info, false))),
      files: changes.map((change) => world.kit.objects.file(repo, head.sha, change)),
    });
  });

  // The paths under `/commits/{ref}` that have their own handlers (check runs, statuses) are registered before this one.
  register("get", "/commits/:ref{[^/]+}", contents, async (call) =>
    call.c.json(await commitJson(call, await commitOf(call, call.c.req.param("ref") ?? ""), true)),
  );

  // --- Contents -----------------------------------------------------------------------------

  const fileJson = (call: Call, path: string, sha: string, ref: string, bytes: Uint8Array | undefined): Json => {
    const { objects } = call.world.kit;
    const api = objects.repoApi(call.repo);
    const html = `${objects.repoWeb(call.repo)}/blob/${ref}/${path}`;
    return {
      name: path.split("/").at(-1),
      path,
      sha,
      size: bytes?.length ?? 0,
      url: `${api}/contents/${path}?ref=${ref}`,
      html_url: html,
      git_url: `${api}/git/blobs/${sha}`,
      download_url: `${objects.repoWeb(call.repo)}/raw/${ref}/${path}`,
      type: "file",
      ...(bytes ? { content: `${base64(bytes).replace(/(.{60})/g, "$1\n")}\n`, encoding: "base64" } : {}),
      _links: { self: `${api}/contents/${path}?ref=${ref}`, git: `${api}/git/blobs/${sha}`, html },
    };
  };

  register("get", "/contents/*", contents, async (call) => {
    const { c, world, repo } = call;
    const path = rest(call, "/contents/").replace(/\/$/, "");
    const ref = c.req.query("ref") ?? repo.defaultBranch;
    const sha = await world.kit.git.resolve(dirOf(call), ref);
    if (!sha) throw new GitHubRefusal(404, `No commit found for the ref ${ref}`);
    const files = await world.kit.git.files(dirOf(call), sha);
    const file = files.get(path);
    if (file) return c.json(fileJson(call, path, file.sha, ref, await world.kit.git.readBlob(dirOf(call), file.sha)));
    // A directory lists what is directly in it.
    const prefix = path === "" ? "" : `${path}/`;
    const children = new Map<string, Json>();
    for (const [name, entry] of files) {
      if (!name.startsWith(prefix)) continue;
      const [child = "", ...deeper] = name.slice(prefix.length).split("/");
      const childPath = `${prefix}${child}`;
      if (deeper.length === 0) children.set(child, fileJson(call, childPath, entry.sha, ref, undefined));
      else if (!children.has(child)) {
        const api = world.kit.objects.repoApi(repo);
        const html = `${world.kit.objects.repoWeb(repo)}/tree/${ref}/${childPath}`;
        const tree = (await world.kit.git.treeAt(dirOf(call), sha, childPath)) ?? "";
        children.set(child, {
          name: child,
          path: childPath,
          sha: tree,
          size: 0,
          url: `${api}/contents/${childPath}?ref=${ref}`,
          html_url: html,
          git_url: `${api}/git/trees/${tree}`,
          download_url: null,
          type: "dir",
          _links: { self: `${api}/contents/${childPath}?ref=${ref}`, git: `${api}/git/trees/${tree}`, html },
        });
      }
    }
    if (children.size === 0) throw notFound();
    return c.json([...children.values()]);
  });

  /** Create, update or delete one file with a commit of its own, as the contents API does. */
  const change = async (call: Call, removing: boolean) => {
    const { c, world, repo, body, bot } = call;
    const path = rest(call, "/contents/");
    const message = text(body, "message");
    if (message === undefined) throw invalid("Commit", "message");
    const content = text(body, "content");
    if (!removing && content === undefined) throw invalid("Commit", "content");
    const branchName = text(body, "branch") ?? repo.defaultBranch;
    const dir = dirOf(call);
    const tip = await world.kit.git.branch(dir, branchName);
    if (!tip) throw new GitHubRefusal(404, `Branch ${branchName} not found`);
    const existing = (await world.kit.git.files(dir, tip)).get(path);
    // Changing a file needs the blob it replaces, so two writers can't silently overwrite each other.
    if (existing && text(body, "sha") !== existing.sha) {
      throw text(body, "sha") === undefined
        ? new GitHubRefusal(422, `Invalid request.\n\n"sha" wasn't supplied.`)
        : new GitHubRefusal(409, `${path} does not match ${text(body, "sha")}`);
    }
    if (removing && !existing) throw notFound();
    const author = body.author as { name?: string; email?: string } | undefined;
    const bytes = removing ? null : Buffer.from(content ?? "", "base64");
    const { sha } = await world.repos.commitTo(
      repo,
      bot,
      branchName,
      new Map([[path, bytes]]),
      message,
      author?.name && author.email ? { name: author.name, email: author.email } : undefined,
    );
    const info = await commitOf(call, sha);
    const blob = removing ? undefined : (await world.kit.git.files(dir, sha)).get(path);
    return c.json(
      {
        content:
          blob && bytes
            ? { ...fileJson(call, path, blob.sha, branchName, bytes), content: undefined, encoding: undefined }
            : null,
        commit: world.kit.objects.gitCommit(repo, info),
      },
      removing || existing ? 200 : 201,
    );
  };
  register("put", "/contents/*", write, (call) => change(call, false));
  register("delete", "/contents/*", write, (call) => change(call, true));

  // --- Git data -----------------------------------------------------------------------------

  register("post", "/git/blobs", write, async (call) => {
    const { c, world, repo, body } = call;
    const content = text(body, "content");
    if (content === undefined) throw invalid("Blob", "content");
    const bytes = body.encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
    const sha = await world.kit.git.writeBlob(dirOf(call), bytes);
    return c.json({ sha, url: `${world.kit.objects.repoApi(repo)}/git/blobs/${sha}` }, 201);
  });

  register("get", "/git/blobs/:sha", contents, async (call) => {
    const { c, world, repo } = call;
    const sha = c.req.param("sha") ?? "";
    const bytes = await world.kit.git.readBlob(dirOf(call), sha);
    if (!bytes) throw notFound();
    return c.json({
      sha,
      node_id: githubNodeId("Blob", [repo.id, sha]),
      size: bytes.length,
      url: `${world.kit.objects.repoApi(repo)}/git/blobs/${sha}`,
      content: `${base64(bytes)}\n`,
      encoding: "base64",
    });
  });

  const treeJson = (call: Call, sha: string, entries: readonly (GitTreeEntry & { size?: number })[]): Json => {
    const api = call.world.kit.objects.repoApi(call.repo);
    return {
      sha,
      url: `${api}/git/trees/${sha}`,
      tree: entries.map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        type: entry.type,
        sha: entry.sha,
        ...(entry.size === undefined ? {} : { size: entry.size }),
        url: `${api}/git/${entry.type === "tree" ? "trees" : "blobs"}/${entry.sha}`,
      })),
      truncated: false,
    };
  };

  register("post", "/git/trees", write, async (call) => {
    const { c, world, body } = call;
    const { git } = world.kit;
    const dir = dirOf(call);
    const entries = body.tree;
    if (!Array.isArray(entries)) throw invalid("Tree", "tree");
    const baseTree = text(body, "base_tree");
    const files = baseTree ? await git.files(dir, baseTree) : new Map<string, { sha: string; mode: string }>();
    for (const entry of entries as Array<Json | null>) {
      if (typeof entry !== "object" || entry === null || typeof entry.path !== "string") throw invalid("Tree", "path");
      const { path, mode, sha: given } = entry as { path: string; mode?: string; sha?: string | null };
      // Whatever was at the path goes: a file, or everything under a directory of that name.
      for (const known of [...files.keys()]) if (known === path || known.startsWith(`${path}/`)) files.delete(known);
      // `sha: null` deletes; a tree puts everything under it at the path; `content` writes a blob.
      if (given === null) continue;
      if (entry.type === "tree" || mode === TREE_MODE) {
        if (!given || !(await git.readTree(dir, given))) throw new GitHubRefusal(422, "tree.sha is not a valid tree");
        for (const [name, file] of await git.files(dir, given)) files.set(`${path}/${name}`, file);
        continue;
      }
      const sha = given ?? (await git.writeBlob(dir, text(entry, "content") ?? ""));
      if (!(await git.readBlob(dir, sha))) throw new GitHubRefusal(422, "tree.sha is not a valid blob");
      files.set(path, { sha, mode: mode ?? FILE_MODE });
    }
    const sha = await git.treeOf(dir, files);
    return c.json(treeJson(call, sha, (await git.readTree(dir, sha)) ?? []), 201);
  });

  register("get", "/git/trees/:sha", contents, async (call) => {
    const { c, world } = call;
    const { git } = world.kit;
    const dir = dirOf(call);
    const named = c.req.param("sha") ?? "";
    const commit = await git.resolve(dir, named);
    const sha = commit ? ((await git.readCommit(dir, commit))?.tree ?? named) : named;
    const top = await git.readTree(dir, sha);
    if (!top) throw notFound();
    if (c.req.query("recursive") === undefined) return c.json(treeJson(call, sha, top));
    const all: GitTreeEntry[] = [];
    const walk = async (tree: string, prefix: string): Promise<void> => {
      for (const entry of (await git.readTree(dir, tree)) ?? []) {
        all.push({ ...entry, path: `${prefix}${entry.path}` });
        if (entry.type === "tree") await walk(entry.sha, `${prefix}${entry.path}/`);
      }
    };
    await walk(sha, "");
    return c.json(treeJson(call, sha, all));
  });

  register("post", "/git/commits", write, async (call) => {
    const { c, world, repo, body, bot } = call;
    const { git, store } = world.kit;
    const dir = dirOf(call);
    const message = text(body, "message");
    const tree = text(body, "tree");
    if (message === undefined) throw invalid("Commit", "message");
    if (tree === undefined || !(await git.readTree(dir, tree))) throw new GitHubRefusal(422, "Tree SHA does not exist");
    const parents = Array.isArray(body.parents) ? (body.parents as string[]) : [];
    for (const parent of parents) {
      if (!(await git.readCommit(dir, parent)))
        throw new GitHubRefusal(422, "Parent SHA does not exist or is not a commit object");
    }
    const given = (who: unknown) => {
      const person = who as { name?: string; email?: string; date?: string } | undefined;
      if (!person?.name || !person.email) return undefined;
      return {
        name: person.name,
        email: person.email,
        date: time(person, "date", "Commit") ?? world.kit.context.clock(),
      };
    };
    // Without an author, the commit is the App's own.
    const own = { ...world.kit.identity(store.bot), date: world.kit.context.clock() };
    const author = given(body.author) ?? own;
    const sha = await git.writeCommit(dir, {
      message,
      tree,
      parents,
      author,
      committer: given(body.committer) ?? author,
    });
    store.commitActors.set(`${repo.id}:${sha}`, bot);
    const info = await git.readCommit(dir, sha);
    if (!info) throw notFound();
    return c.json(world.kit.objects.gitCommit(repo, info), 201);
  });

  register("get", "/git/commits/:sha", contents, async (call) => {
    const info = await call.world.kit.git.readCommit(dirOf(call), call.c.req.param("sha") ?? "");
    if (!info) throw notFound();
    return call.c.json(call.world.kit.objects.gitCommit(call.repo, info));
  });

  const refJson = (call: Call, branchName: string, sha: string): Json => {
    const api = call.world.kit.objects.repoApi(call.repo);
    return {
      ref: `refs/heads/${branchName}`,
      node_id: githubNodeId("Ref", [call.repo.id, `refs/heads/${branchName}`]),
      url: `${api}/git/refs/heads/${branchName}`,
      object: { sha, type: "commit", url: `${api}/git/commits/${sha}` },
    };
  };
  /** `heads/<branch>` from a ref in a path or a body. The fake has branches only: no tags. */
  const branchNamed = (ref: string): string | undefined => /^(?:refs\/)?heads\/(.+)$/.exec(ref)?.[1];

  register("get", "/git/ref/*", contents, async (call) => {
    const name = branchNamed(rest(call, "/git/ref/"));
    const sha = name ? await call.world.kit.git.branch(dirOf(call), name) : undefined;
    if (!name || !sha) throw notFound();
    return call.c.json(refJson(call, name, sha));
  });

  register("get", "/git/matching-refs/*", contents, async (call) => {
    const prefix = branchNamed(rest(call, "/git/matching-refs/")) ?? "";
    const { git } = call.world.kit;
    const names = (await git.branches(dirOf(call))).filter((name) => name.startsWith(prefix));
    const refs = await Promise.all(
      names.map(async (name) => refJson(call, name, (await git.branch(dirOf(call), name)) ?? "")),
    );
    return call.c.json(page(call.c, refs));
  });

  register("post", "/git/refs", write, async (call) => {
    const { c, world, repo, body, bot } = call;
    const { git } = world.kit;
    const name = branchNamed(text(body, "ref") ?? "");
    const sha = text(body, "sha");
    if (!name || !(text(body, "ref") ?? "").startsWith("refs/"))
      throw new GitHubRefusal(422, "Reference name must start with refs/heads/");
    if (!sha || !(await git.readCommit(dirOf(call), sha))) throw new GitHubRefusal(422, "Object does not exist");
    if (await git.branch(dirOf(call), name)) throw new GitHubRefusal(422, "Reference already exists");
    await git.setBranch(dirOf(call), name, sha);
    await world.repos.afterPush(repo, bot, name, undefined, sha);
    return c.json(refJson(call, name, sha), 201);
  });

  register("patch", "/git/refs/*", write, async (call) => {
    const { c, world, repo, body, bot } = call;
    const { git } = world.kit;
    const dir = dirOf(call);
    const name = branchNamed(rest(call, "/git/refs/"));
    const before = name ? await git.branch(dir, name) : undefined;
    if (!name || !before) throw new GitHubRefusal(422, "Reference does not exist");
    const sha = text(body, "sha");
    if (!sha || !(await git.readCommit(dir, sha))) throw new GitHubRefusal(422, "Object does not exist");
    // Moving a branch somewhere its old tip isn't part of needs `force`.
    const forward = (await git.log(dir, sha)).some((commit) => commit.sha === before);
    if (!forward && body.force !== true) throw new GitHubRefusal(422, "Update is not a fast forward");
    await git.setBranch(dir, name, sha);
    if (sha !== before) await world.repos.afterPush(repo, bot, name, before, sha, !forward);
    return c.json(refJson(call, name, sha));
  });

  register("delete", "/git/refs/*", write, async (call) => {
    const { c, world, repo, bot } = call;
    const name = branchNamed(rest(call, "/git/refs/"));
    const before = name ? await world.kit.git.branch(dirOf(call), name) : undefined;
    if (!name || !before) throw new GitHubRefusal(422, "Reference does not exist");
    await world.kit.git.deleteBranch(dirOf(call), name);
    await world.repos.afterPush(repo, bot, name, before, undefined);
    return c.body(null, 204);
  });

  // --- Labels of the repository ---------------------------------------------------------------

  register("get", "/labels", ["issues", "read"], ({ c, world, repo }) =>
    c.json(page(c, [...repo.labels.values()]).map((label) => world.kit.objects.label(repo, label))),
  );

  register("get", "/labels/:name", ["issues", "read"], ({ c, world, repo }) => {
    const label = repo.labels.get((c.req.param("name") ?? "").toLowerCase());
    if (!label) throw notFound();
    return c.json(world.kit.objects.label(repo, label));
  });

  register("post", "/labels", ["issues", "write"], ({ c, world, repo, body }) => {
    const name = text(body, "name");
    if (!name) throw invalid("Label", "name");
    if (repo.labels.has(name.toLowerCase())) throw invalid("Label", "name", "already_exists");
    const label = world.repos.addLabel(repo, {
      name,
      color: text(body, "color"),
      description: text(body, "description"),
    });
    return c.json(world.kit.objects.label(repo, label), 201);
  });
}
