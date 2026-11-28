import { AppRoster } from "../../../core/apps/index.ts";
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
  /** The built-in app and the ones tests made (decision 0027), each installed workspace-wide. */
  readonly apps: AppRoster<LinearAppRecord>;
  /** Each app's own user, by its id. They belong to no session. */
  readonly #appUsers = new Map<string, LinearUserRecord>();

  constructor(registry: Registry) {
    this.apps = new AppRoster("Linear", registry);
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

  /** The built-in app, `my-agent`. */
  get app(): LinearAppRecord {
    return this.apps.builtIn;
  }

  /** The built-in app's user. It belongs to no session. */
  get appUser(): LinearUserRecord {
    return this.appUserOf(this.app);
  }

  /** The built-in app and its user. The apps tests made stay: they live as long as the server. */
  seed(org: LinearOrgRecord, app: LinearAppRecord, appUser: LinearUserRecord): void {
    this.#org = org;
    this.apps.seed(app);
    this.#appUsers.set(appUser.id, appUser);
  }

  /** Keep the user of an app a test made. */
  addAppUser(user: LinearUserRecord): void {
    this.#appUsers.set(user.id, user);
  }

  /** The user an app acts as. */
  appUserOf(app: LinearAppRecord): LinearUserRecord {
    const user = this.#appUsers.get(app.userId);
    if (!user) throw new Error(`The Linear app ${app.name} has no user`);
    return user;
  }

  /** Every app's user, the built-in app's first. */
  appUsers(): LinearUserRecord[] {
    return this.apps.all().map((app) => this.appUserOf(app));
  }

  /** The app whose user this is, if any. */
  appByUser(id: string): LinearAppRecord | undefined {
    return this.apps.all().find((app) => app.userId === id);
  }

  /** The app a handle names: its user's id, or its name. */
  appOf(ref: string): LinearAppRecord | undefined {
    return this.appByUser(ref) ?? this.apps.named(ref);
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

  /** Whoever acts under this id: a person, or an app's user. */
  user(id: string): LinearUserRecord | undefined {
    return this.#appUsers.get(id) ?? this.users.find(id);
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
