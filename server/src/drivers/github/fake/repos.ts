import { ProtocolError } from "../../../core/errors/index.ts";
import type {
  GitHubCommitInfo,
  GitHubFileChange,
  GitHubIssueRecord,
  GitHubLabelRecord,
  GitHubOrgRole,
  GitHubPermission,
  GitHubRepoRecord,
  GitHubUserRecord,
} from "../world.ts";
import { type GitHubKit, GitHubRefusal } from "./kit.ts";

/** The labels GitHub gives a new repository. */
const DEFAULT_LABELS: ReadonlyArray<readonly [string, string, string]> = [
  ["bug", "d73a4a", "Something isn't working"],
  ["documentation", "0075ca", "Improvements or additions to documentation"],
  ["duplicate", "cfd3d7", "This issue or pull request already exists"],
  ["enhancement", "a2eeef", "New feature or request"],
  ["good first issue", "7057ff", "Good for newcomers"],
  ["help wanted", "008672", "Extra attention is needed"],
  ["invalid", "e4e669", "This doesn't seem right"],
  ["question", "d876e3", "Further information is requested"],
  ["wontfix", "ffffff", "This will not be worked on"],
];

const ZERO_SHA = "0".repeat(40);
const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const REPO_NAME = /^[\w.-]{1,100}$/;

export interface GitHubUserInput {
  login: string;
  id?: number | undefined;
  name?: string | undefined;
  email?: string | undefined;
  role?: GitHubOrgRole | undefined;
}

export interface GitHubRepoInput {
  name?: string | undefined;
  private?: boolean | undefined;
  defaultBranch?: string | undefined;
  /** The first commit's files. Without any, GitHub's own start: a README. */
  files?: ReadonlyArray<{ path: string; content: Uint8Array | string }> | undefined;
  collaborators?: ReadonlyArray<{ user: number; permission: GitHubPermission }> | undefined;
  installed?: boolean | undefined;
  labels?: ReadonlyArray<{ name: string; color?: string | undefined; description?: string | undefined }> | undefined;
}

/** People, repositories and their git history: creating them, pushing, and what a push sets off. */
export function createRepos(kit: GitHubKit) {
  const { context, store, git, objects } = kit;
  const { ids, clock } = context;

  /** Who a commit is attributed to: whoever made it here, else whoever's email it carries. */
  const commitAuthor = (repo: GitHubRepoRecord, info: GitHubCommitInfo): GitHubUserRecord | undefined => {
    const made = store.commitActors.get(`${repo.id}:${info.sha}`);
    if (made !== undefined) return store.actor(made);
    const people = [store.bot, ...store.list(store.users, store.sessionOf(repo))];
    return people.find((person) => kit.identity(person).email === info.author.email);
  };

  /** Keep a pull request's head, base and totals current after a branch moved. */
  const refreshPull = async (repo: GitHubRepoRecord, issue: GitHubIssueRecord): Promise<void> => {
    const pull = issue.pull;
    if (!pull || issue.state !== "open") return;
    const [head, base] = await Promise.all([
      git.branch(kit.dir(repo), pull.head),
      git.branch(kit.dir(repo), pull.base),
    ]);
    if (head) pull.headSha = head;
    if (base) pull.baseSha = base;
    const from = (await git.mergeBase(kit.dir(repo), pull.baseSha, pull.headSha)) ?? pull.baseSha;
    const [commits, changes] = await Promise.all([
      git.ahead(kit.dir(repo), pull.baseSha, pull.headSha),
      git.changes(kit.dir(repo), from, pull.headSha),
    ]);
    pull.stats = {
      commits: commits.length,
      additions: changes.reduce((sum, change) => sum + change.additions, 0),
      deletions: changes.reduce((sum, change) => sum + change.deletions, 0),
      changedFiles: changes.length,
    };
  };

  /**
   * A branch moved, by a push, an API call or a merge: GitHub sends `push`, and `pull_request`
   * `synchronize` for every open pull request from that branch.
   */
  const afterPush = async (
    repo: GitHubRepoRecord,
    actor: number,
    branch: string,
    before: string | undefined,
    after: string | undefined,
  ): Promise<string | undefined> => {
    const dir = kit.dir(repo);
    repo.pushedAt = clock();
    repo.updatedAt = clock();
    const pusher = store.actor(actor);
    const commits = after ? await git.ahead(dir, before ?? (await defaultTip(repo)) ?? after, after) : [];
    const listed = await Promise.all(
      commits.map(async (info) => {
        const changes = await git.changes(dir, info.parents[0], info.sha);
        return objects.pushCommit(repo, info, changes, commitAuthor(repo, info)?.login);
      }),
    );
    const pushed = kit.emit(repo, "push", actor, {
      ref: `refs/heads/${branch}`,
      before: before ?? ZERO_SHA,
      after: after ?? ZERO_SHA,
      created: before === undefined,
      deleted: after === undefined,
      forced: false,
      base_ref: null,
      compare: `${objects.repoWeb(repo)}/compare/${(before ?? ZERO_SHA).slice(0, 12)}...${(after ?? ZERO_SHA).slice(0, 12)}`,
      commits: listed,
      head_commit: listed.at(-1) ?? null,
      pusher: { name: pusher.login, email: kit.identity(pusher).email },
    });
    for (const issue of store.issuesOf(repo)) {
      if (!issue.pull || issue.state !== "open") continue;
      await refreshPull(repo, issue);
      // Whether the head moved is what the push says, not what the record held: a read that came
      // in between may have brought the record up to date already.
      if (issue.pull.head === branch && after !== undefined && before !== undefined && before !== after) {
        issue.updatedAt = clock();
        kit.issueEvent(issue, actor, "synchronize", { before, after });
      }
    }
    return pushed;
  };

  const defaultTip = (repo: GitHubRepoRecord) => git.branch(kit.dir(repo), repo.defaultBranch);

  /** Commit changes to a branch as someone, and let GitHub react to the push. */
  const commitTo = async (
    repo: GitHubRepoRecord,
    actor: number,
    branch: string,
    changes: ReadonlyMap<string, Uint8Array | string | null>,
    message: string,
    author?: { name: string; email: string; date?: number },
  ): Promise<{ sha: string; delivery: string | undefined }> => {
    const dir = kit.dir(repo);
    const before = await git.branch(dir, branch);
    // A branch that isn't there yet starts from the default branch.
    const parent = before ?? (await defaultTip(repo));
    const sha = await git.commitChanges(dir, {
      parent,
      changes,
      message,
      author: { ...(author ?? kit.identity(store.actor(actor))), date: author?.date ?? clock() },
    });
    store.commitActors.set(`${repo.id}:${sha}`, actor);
    await git.setBranch(dir, branch, sha);
    return { sha, delivery: await afterPush(repo, actor, branch, before, sha) };
  };

  const addLabel = (
    repo: GitHubRepoRecord,
    input: { name: string; color?: string | undefined; description?: string | undefined },
  ): GitHubLabelRecord => {
    const record: GitHubLabelRecord = {
      id: Number(ids.next("github.label")),
      name: input.name,
      color: (input.color ?? "ededed").replace(/^#/, ""),
      description: input.description ?? null,
    };
    repo.labels.set(input.name.toLowerCase(), record);
    return record;
  };

  /** `installation_repositories`: the App was given a repository, or lost one. */
  const installationChanged = (repo: GitHubRepoRecord, action: "added" | "removed"): string | undefined => {
    const listed = [
      {
        id: repo.id,
        node_id: objects.repository(repo).node_id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        private: repo.private,
      },
    ];
    return kit.emit(repo, "installation_repositories", "org", {
      action,
      installation: objects.installation(),
      repository_selection: "selected",
      repositories_added: action === "added" ? listed : [],
      repositories_removed: action === "removed" ? listed : [],
      requester: null,
    });
  };

  return {
    commitAuthor,
    refreshPull,
    afterPush,
    commitTo,
    addLabel,

    createUser(session: string, input: GitHubUserInput): GitHubUserRecord {
      if (!LOGIN.test(input.login)) {
        throw new ProtocolError("invalid_argument", `"${input.login}" is not a valid GitHub login`);
      }
      // Logins are unique among one session's people; two sessions can each have an `ana` (decision 0013).
      if (store.byLogin(session, input.login)) {
        throw new ProtocolError("invalid_argument", `There is already a person "${input.login}" in this session`);
      }
      const id = input.id === undefined ? ids.next("github.user") : ids.reserve("github.user", String(input.id));
      return store.add(store.users, session, {
        id: Number(id),
        login: input.login,
        name: input.name,
        email: input.email,
        type: "User",
        role: input.role ?? "member",
        fixedId: input.id !== undefined,
        createdAt: clock(),
      });
    },

    async createRepo(session: string, input: GitHubRepoInput): Promise<GitHubRepoRecord> {
      const id = Number(ids.next("github.repo"));
      const name = input.name ?? `test-${id}`;
      if (!REPO_NAME.test(name))
        throw new ProtocolError("invalid_argument", `"${name}" is not a valid repository name`);
      // The agent names a repository in every path, so a name is one repository in the whole world (decision 0013).
      if (store.repoNamed(store.org.login, name)) {
        throw new ProtocolError(
          "invalid_argument",
          `A repository "${store.org.login}/${name}" already exists, here or in another open session`,
        );
      }
      const now = clock();
      const repo = store.add(store.repos, session, {
        id,
        owner: store.org.login,
        name,
        private: input.private ?? true,
        defaultBranch: input.defaultBranch ?? "main",
        collaborators: new Map(
          (input.collaborators ?? []).map(({ user, permission }) => [store.actor(user).login, permission]),
        ),
        installed: false,
        labels: new Map(),
        createdAt: now,
        pushedAt: now,
        updatedAt: now,
      });
      for (const [labelName, color, description] of DEFAULT_LABELS)
        addLabel(repo, { name: labelName, color, description });
      for (const label of input.labels ?? []) addLabel(repo, label);
      const dir = kit.dir(repo);
      await git.init(dir, repo.defaultBranch);
      const files = input.files?.length ? input.files : [{ path: "README.md", content: `# ${name}\n` }];
      const first = await git.commitChanges(dir, {
        parent: undefined,
        changes: new Map(files.map((file) => [file.path.replace(/^\.?\//, ""), file.content])),
        message: "Initial commit",
        author: {
          name: store.org.login,
          email: `${store.org.id}+${store.org.login}@users.noreply.github.com`,
          date: now,
        },
      });
      await git.setBranch(dir, repo.defaultBranch, first);
      if (input.installed) {
        repo.installed = true;
        installationChanged(repo, "added");
      }
      return repo;
    },

    /** Give the App a repository, or take it away. Answers with the delivery that told it, if it could be told. */
    setInstalled(repo: GitHubRepoRecord, installed: boolean): string | undefined {
      if (repo.installed === installed) {
        throw new GitHubRefusal(
          422,
          `The app is ${installed ? "already" : "not"} installed on ${repo.owner}/${repo.name}`,
        );
      }
      repo.installed = installed;
      kit.action(repo, installed ? "installApp" : "uninstallApp", { repo: `${repo.owner}/${repo.name}` });
      return installationChanged(repo, installed ? "added" : "removed");
    },

    /** A file's bytes at a branch or commit. */
    async readFile(repo: GitHubRepoRecord, path: string, ref?: string): Promise<Uint8Array | undefined> {
      const dir = kit.dir(repo);
      const sha = await git.resolve(dir, ref ?? repo.defaultBranch);
      if (!sha) return undefined;
      const file = (await git.files(dir, sha)).get(path.replace(/^\//, ""));
      return file ? git.readBlob(dir, file.sha) : undefined;
    },

    /** What changed in a pull request, against where it branched off. */
    async pullChanges(repo: GitHubRepoRecord, issue: GitHubIssueRecord): Promise<GitHubFileChange[]> {
      const pull = issue.pull;
      if (!pull) return [];
      const dir = kit.dir(repo);
      // A merged pull request is compared with the base it was merged into, as it was then.
      const from = (await git.mergeBase(dir, pull.baseSha, pull.headSha)) ?? pull.baseSha;
      return git.changes(
        dir,
        from === pull.headSha ? (await git.readCommit(dir, from))?.parents[0] : from,
        pull.headSha,
      );
    },
  };
}

export type GitHubRepos = ReturnType<typeof createRepos>;
