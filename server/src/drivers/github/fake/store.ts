import { ProtocolError } from "../../../core/errors/index.ts";
import type { Collection, Registry } from "../../../core/registry/index.ts";
import type {
  GitHubAppRecord,
  GitHubCheckRunRecord,
  GitHubCommentRecord,
  GitHubHookDeliveryRecord,
  GitHubIssueRecord,
  GitHubOrgRecord,
  GitHubRepoRecord,
  GitHubReviewCommentRecord,
  GitHubReviewRecord,
  GitHubStatusRecord,
  GitHubUserRecord,
} from "../world.ts";

/** The GitHub fake's in-memory state. Objects live in the core registry; the store adds GitHub's own indexes. */
export class GitHubStore {
  readonly users: Collection<GitHubUserRecord>;
  readonly repos: Collection<GitHubRepoRecord>;
  readonly issues: Collection<GitHubIssueRecord>;
  readonly comments: Collection<GitHubCommentRecord>;
  readonly reviews: Collection<GitHubReviewRecord>;
  readonly reviewComments: Collection<GitHubReviewCommentRecord>;
  readonly checkRuns: Collection<GitHubCheckRunRecord>;
  readonly statuses: Collection<GitHubStatusRecord>;
  /** Per session, in the order they were made: the registry has no listing. */
  readonly #created = new Map<string, Map<Collection<{ id: number }>, number[]>>();
  /** The App's delivery log, newest last. */
  readonly hookDeliveries: GitHubHookDeliveryRecord[] = [];
  /** Who made a commit here (`<repo id>:<sha>` → user id): GitHub attributes it to them. */
  readonly commitActors = new Map<string, number>();
  /** The threads on the diff that are resolved, by thread id. */
  readonly resolvedThreads = new Set<number>();
  /** A check suite per repo and commit: check runs of one commit share it. */
  readonly suites = new Map<string, number>();
  #org: GitHubOrgRecord | undefined;
  #app: GitHubAppRecord | undefined;
  #bot: GitHubUserRecord | undefined;

  constructor(registry: Registry) {
    this.users = registry.collection("github", "user");
    this.repos = registry.collection("github", "repo");
    this.issues = registry.collection("github", "issue");
    this.comments = registry.collection("github", "comment");
    this.reviews = registry.collection("github", "review");
    this.reviewComments = registry.collection("github", "reviewComment");
    this.checkRuns = registry.collection("github", "checkRun");
    this.statuses = registry.collection("github", "status");
  }

  get org(): GitHubOrgRecord {
    if (!this.#org) throw new Error("The GitHub fake hasn't been seeded");
    return this.#org;
  }

  get app(): GitHubAppRecord {
    if (!this.#app) throw new Error("The GitHub fake hasn't been seeded");
    return this.#app;
  }

  /** The bot user that acts for the App. It belongs to no session. */
  get bot(): GitHubUserRecord {
    if (!this.#bot) throw new Error("The GitHub fake hasn't been seeded");
    return this.#bot;
  }

  seed(org: GitHubOrgRecord, app: GitHubAppRecord): void {
    this.#org = org;
    this.#app = app;
    this.#bot = {
      id: app.botId,
      login: `${app.slug}[bot]`,
      name: undefined,
      email: undefined,
      type: "Bot",
      role: "member",
      fixedId: false,
      createdAt: app.createdAt,
    };
    this.#created.clear();
    this.hookDeliveries.length = 0;
    this.suites.clear();
    this.commitActors.clear();
    this.resolvedThreads.clear();
  }

  /** Keep a new object for its session. */
  add<T extends { id: number }>(collection: Collection<T>, session: string, record: T): T {
    let mine = this.#created.get(session);
    if (!mine) {
      mine = new Map();
      this.#created.set(session, mine);
    }
    const ids = mine.get(collection as Collection<{ id: number }>) ?? [];
    ids.push(record.id);
    mine.set(collection as Collection<{ id: number }>, ids);
    return collection.add(String(record.id), record, session);
  }

  /** Everything of one kind a session made, oldest first. */
  list<T extends { id: number }>(collection: Collection<T>, session: string): T[] {
    const ids = this.#created.get(session)?.get(collection as Collection<{ id: number }>) ?? [];
    return ids.map((id) => collection.find(String(id))).filter((record): record is T => record !== undefined);
  }

  /** Delete an object: it leaves its session's listing and the registry, so nothing reaches it any more. */
  forget<T extends { id: number }>(collection: Collection<T>, session: string, id: number): void {
    const ids = this.#created.get(session)?.get(collection as Collection<{ id: number }>);
    if (ids?.includes(id)) ids.splice(ids.indexOf(id), 1);
    collection.remove(String(id));
  }

  /** Whoever acts under this id: a person, or the App's bot. */
  actor(id: number): GitHubUserRecord {
    if (id === this.bot.id) return this.bot;
    const user = this.users.find(String(id));
    if (!user) throw new Error(`No GitHub user ${id}`);
    return user;
  }

  /** A person or the bot by login, among the people of one session. */
  byLogin(session: string, login: string): GitHubUserRecord | undefined {
    if (login === this.bot.login) return this.bot;
    return this.list(this.users, session).find((user) => user.login.toLowerCase() === login.toLowerCase());
  }

  /** Someone by login from the platform's side, where there are no sessions: the newest person of that name. */
  anyByLogin(login: string): GitHubUserRecord | undefined {
    if (login === this.bot.login) return this.bot;
    return [...this.#created.keys()].flatMap((session) => this.byLogin(session, login) ?? []).at(-1);
  }

  /** Every repository the App is installed on, in any session. */
  installedRepos(): GitHubRepoRecord[] {
    return [...this.#created.keys()]
      .flatMap((session) => this.list(this.repos, session))
      .filter((repo) => repo.installed);
  }

  /** A repository from the platform's side, where a path names it: `acme/web`. Names are unique in the world. */
  repoNamed(owner: string, name: string): GitHubRepoRecord | undefined {
    if (owner.toLowerCase() !== this.org.login.toLowerCase()) return undefined;
    return [...this.#created.keys()]
      .flatMap((session) => this.list(this.repos, session))
      .find((repo) => repo.name.toLowerCase() === name.toLowerCase());
  }

  /** The session a repository belongs to. Everything in a repository belongs to the same one. */
  sessionOf(repo: GitHubRepoRecord): string {
    const session = this.repos.owner(String(repo.id));
    if (session === undefined) throw new Error(`Repository ${repo.name} belongs to no session`);
    return session;
  }

  repo(id: number): GitHubRepoRecord {
    const repo = this.repos.find(String(id));
    if (!repo) throw new Error(`No GitHub repository ${id}`);
    return repo;
  }

  /** A repository of this session by name, for the control API. */
  repoOf(session: string, owner: string, name: string): GitHubRepoRecord {
    const repo = this.repoNamed(owner, name);
    if (!repo || this.sessionOf(repo) !== session) {
      throw new ProtocolError("not_found", `No repository "${owner}/${name}" in this session`);
    }
    return repo;
  }

  issuesOf(repo: GitHubRepoRecord): GitHubIssueRecord[] {
    return this.list(this.issues, this.sessionOf(repo)).filter((issue) => issue.repo === repo.id);
  }

  issue(repo: GitHubRepoRecord, number: number): GitHubIssueRecord | undefined {
    return this.issuesOf(repo).find((issue) => issue.number === number);
  }

  commentsOn(repo: GitHubRepoRecord, issue: number): GitHubCommentRecord[] {
    return this.list(this.comments, this.sessionOf(repo)).filter(
      (comment) => comment.repo === repo.id && comment.issue === issue,
    );
  }

  reviewsOf(repo: GitHubRepoRecord, pull: number): GitHubReviewRecord[] {
    return this.list(this.reviews, this.sessionOf(repo)).filter(
      (review) => review.repo === repo.id && review.pull === pull,
    );
  }

  reviewCommentsOf(repo: GitHubRepoRecord, pull?: number): GitHubReviewCommentRecord[] {
    return this.list(this.reviewComments, this.sessionOf(repo)).filter(
      (comment) => comment.repo === repo.id && (pull === undefined || comment.pull === pull),
    );
  }

  checkRunsOf(repo: GitHubRepoRecord, sha?: string): GitHubCheckRunRecord[] {
    return this.list(this.checkRuns, this.sessionOf(repo)).filter(
      (run) => run.repo === repo.id && (sha === undefined || run.headSha === sha),
    );
  }

  statusesOf(repo: GitHubRepoRecord, sha: string): GitHubStatusRecord[] {
    return this.list(this.statuses, this.sessionOf(repo)).filter(
      (status) => status.repo === repo.id && status.sha === sha,
    );
  }

  /** Forget a closed session's indexes. Answers with what the caller still has to clean up. */
  release(session: string): { users: GitHubUserRecord[]; repos: GitHubRepoRecord[] } {
    const released = { users: this.list(this.users, session), repos: this.list(this.repos, session) };
    for (const comment of this.list(this.reviewComments, session)) this.resolvedThreads.delete(comment.thread);
    this.#created.delete(session);
    for (let index = this.hookDeliveries.length - 1; index >= 0; index--) {
      if (this.hookDeliveries[index]?.session === session) this.hookDeliveries.splice(index, 1);
    }
    for (const repo of released.repos) {
      for (const index of [this.suites, this.commitActors]) {
        for (const key of [...index.keys()]) if (key.startsWith(`${repo.id}:`)) index.delete(key);
      }
    }
    return released;
  }
}
