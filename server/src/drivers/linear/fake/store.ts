import type { Collection, Registry } from "../../../core/registry/index.ts";
import type {
  LinearActivityRecord,
  LinearAppRecord,
  LinearCommentRecord,
  LinearIssueRecord,
  LinearOrgRecord,
  LinearSessionRecord,
  LinearTeamRecord,
  LinearUserRecord,
} from "../world.ts";

type Keyed = { id: string };

/** The Linear fake's in-memory state. Objects live in the core registry; the store adds Linear's own indexes. */
export class LinearStore {
  readonly users: Collection<LinearUserRecord>;
  readonly teams: Collection<LinearTeamRecord>;
  readonly issues: Collection<LinearIssueRecord>;
  readonly comments: Collection<LinearCommentRecord>;
  readonly sessions: Collection<LinearSessionRecord>;
  readonly activities: Collection<LinearActivityRecord>;
  #org: LinearOrgRecord | undefined;
  #app: LinearAppRecord | undefined;
  #appUser: LinearUserRecord | undefined;

  constructor(registry: Registry) {
    this.users = registry.collection("linear", "user");
    this.teams = registry.collection("linear", "team");
    this.issues = registry.collection("linear", "issue");
    this.comments = registry.collection("linear", "comment");
    this.sessions = registry.collection("linear", "agentSession");
    this.activities = registry.collection("linear", "agentActivity");
  }

  get org(): LinearOrgRecord {
    if (!this.#org) throw new Error("The Linear fake hasn't been seeded");
    return this.#org;
  }

  get app(): LinearAppRecord {
    if (!this.#app) throw new Error("The Linear fake hasn't been seeded");
    return this.#app;
  }

  /** The app's user. It belongs to no session. */
  get appUser(): LinearUserRecord {
    if (!this.#appUser) throw new Error("The Linear fake hasn't been seeded");
    return this.#appUser;
  }

  seed(org: LinearOrgRecord, app: LinearAppRecord, appUser: LinearUserRecord): void {
    this.#org = org;
    this.#app = app;
    this.#appUser = appUser;
  }

  /** Keep a new object for its session. */
  add<T extends Keyed>(collection: Collection<T>, session: string, record: T): T {
    return collection.add(record.id, record, session);
  }

  /** Everything of one kind a session made, oldest first. */
  list<T>(collection: Collection<T>, session: string): T[] {
    return collection.list(session);
  }

  /** Everything of one kind, in every session: what the app sees of the workspace. */
  all<T>(collection: Collection<T>): T[] {
    return collection.values();
  }

  /** Delete an object: it leaves the registry, and with it its session's listing. */
  forget<T>(collection: Collection<T>, id: string): void {
    collection.remove(id);
  }

  /** Whoever acts under this id: a person, or the app's user. */
  user(id: string): LinearUserRecord | undefined {
    return id === this.appUser.id ? this.appUser : this.users.find(id);
  }

  /** The session an issue (and everything on it) belongs to. */
  sessionOf(issue: LinearIssueRecord): string {
    const session = this.issues.owner(issue.id);
    if (session === undefined) throw new Error(`Issue ${issue.identifier} belongs to no session`);
    return session;
  }

  team(id: string): LinearTeamRecord {
    const team = this.teams.find(id);
    if (!team) throw new Error(`No Linear team ${id}`);
    return team;
  }

  issue(id: string): LinearIssueRecord {
    const issue = this.issues.find(id);
    if (!issue) throw new Error(`No Linear issue ${id}`);
    return issue;
  }

  issuesOf(team: LinearTeamRecord): LinearIssueRecord[] {
    const session = this.teams.owner(team.id);
    return session === undefined ? [] : this.list(this.issues, session).filter((issue) => issue.team === team.id);
  }

  commentsOn(issue: LinearIssueRecord): LinearCommentRecord[] {
    return this.list(this.comments, this.sessionOf(issue)).filter((comment) => comment.issue === issue.id);
  }

  sessionsOn(issue: LinearIssueRecord): LinearSessionRecord[] {
    return this.list(this.sessions, this.sessionOf(issue)).filter((session) => session.issue === issue.id);
  }

  activitiesOf(session: LinearSessionRecord): LinearActivityRecord[] {
    const owner = this.sessions.owner(session.id);
    return owner === undefined
      ? []
      : this.list(this.activities, owner).filter((activity) => activity.session === session.id);
  }

  /** What a closing session has that the caller still has to give back, before the registry drops it. */
  release(session: string): { users: LinearUserRecord[]; teams: LinearTeamRecord[] } {
    return { users: this.list(this.users, session), teams: this.list(this.teams, session) };
  }
}
