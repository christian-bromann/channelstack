import { type DeliveryKit, deliveryKit } from "../../../core/delivery/kit.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { GITHUB_IDS } from "../ids.ts";
import { type GitHubObjects, githubObjects } from "../payloads.ts";
import { signGitHubWebhook } from "../signing.ts";
import {
  type GitHubAppRecord,
  type GitHubIssueRecord,
  type GitHubPermission,
  type GitHubRepoRecord,
  type GitHubUserRecord,
  PERMISSIONS,
} from "../world.ts";
import type { GitStore } from "./git.ts";
import type { GitHubStore } from "./store.ts";

type Json = Record<string, unknown>;

/**
 * GitHub refused: the fake answers the agent with this status and message, and the control API
 * hands it to a test as a platform refusal. `errors` is GitHub's list of what was wrong (422).
 */
export class GitHubRefusal extends ProtocolError {
  /** The HTTP status GitHub answers the agent with. */
  readonly githubStatus: number;
  /** GitHub's list of what was wrong: error objects, or plain sentences where an endpoint answers with those. */
  readonly errors: ReadonlyArray<Json | string> | undefined;

  constructor(status: number, message: string, errors?: ReadonlyArray<Json | string>) {
    // Through the control API a 404 is the protocol's own `not_found`; the rest are GitHub's refusals by name.
    super(status === 404 ? "not_found" : { platform: REFUSALS[status] ?? "github_error", status: 409 }, message, {
      github: status,
    });
    this.githubStatus = status;
    this.errors = errors;
  }
}

const REFUSALS: Readonly<Record<number, string>> = {
  403: "forbidden",
  405: "not_allowed",
  409: "conflict",
  422: "validation_failed",
};

/**
 * GitHub's 422 "Validation Failed" for one field: with a `message` it is GitHub's `custom` error,
 * without one the error `code` says what is wrong (`missing_field`, `invalid`, `already_exists`).
 */
export const invalid = (
  resource: string,
  field: string,
  problem: { message: string } | { code: string } = { code: "missing_field" },
) =>
  new GitHubRefusal(422, "Validation Failed", [
    "message" in problem
      ? { resource, code: "custom", field, message: problem.message }
      : { resource, field, code: problem.code },
  ]);

/** GitHub waits ten seconds for a webhook to be answered. */
const ACK_WINDOW_MS = 10_000;

/** What every part of the fake world builds on: the state, git, the object builders and the way to the agent. */
export interface GitHubKit {
  readonly context: DriverContext;
  readonly store: GitHubStore;
  readonly git: GitStore;
  readonly objects: GitHubObjects;
  /** Where a repository's git objects live. */
  dir(repo: GitHubRepoRecord): string;
  /** Record what a person did, for the session's event log. */
  action(repo: GitHubRepoRecord, name: string, data: Json): void;
  /**
   * Send a webhook about a repository to every App that is installed there, subscribed to the
   * event and reachable, each its own delivery (decision 0027); with `only`, to that App alone.
   * Answers with the GUID of the delivery to `only`, or else to the built-in App, or nothing when
   * that App wasn't sent one.
   */
  emit(
    repo: GitHubRepoRecord,
    event: string,
    sender: number | "org",
    payload: Json,
    only?: GitHubAppRecord,
  ): string | undefined;
  /** GitHub's deliveries: one attempt each, with GitHub's headers, signed with the receiving App's webhook secret over the exact bytes. */
  readonly deliveries: DeliveryKit;
  /** May this person do something that needs `level` on the repository? An App's bot may, where the App is installed. */
  can(repo: GitHubRepoRecord, user: number, level: GitHubPermission): boolean;
  /** Refuse unless they may. */
  allow(repo: GitHubRepoRecord, user: number, level: GitHubPermission): void;
  /**
   * Refuse an App's installation what GitHub refuses its token: a repository it isn't installed on
   * doesn't exist for it (404), and a permission it wasn't granted is 403 `Resource not accessible
   * by integration`. Answers with the repository it may reach.
   */
  allowApp(
    repo: GitHubRepoRecord | undefined,
    app: GitHubAppRecord,
    needs: readonly [permission: string, level: "read" | "write"],
  ): GitHubRepoRecord;
  requireIssue(repo: GitHubRepoRecord, number: number): GitHubIssueRecord;
  /** A pull request, or GitHub's 404 when the number is an issue or nothing. */
  requirePull(
    repo: GitHubRepoRecord,
    number: number,
  ): GitHubIssueRecord & { pull: NonNullable<GitHubIssueRecord["pull"]> };
  /** The git identity GitHub commits under for someone. */
  identity(user: GitHubUserRecord): { name: string; email: string };
  /** Something about an issue or a pull request changed: GitHub moves its `updated_at`. */
  touch(issue: GitHubIssueRecord): void;
  /**
   * Someone wrote on issue or pull request `number`, for the loop guard (decision 0027): an App's
   * comment, review, review comment, edit or change adds to its count, a person's starts it over.
   * Answers whether the events the write causes are still delivered.
   */
  wrote(repo: GitHubRepoRecord, number: number, sender: number): boolean;
  /** `issues` for an issue, `pull_request` for a pull request, with the object under the matching key; counted by the loop guard. */
  issueEvent(issue: GitHubIssueRecord, sender: number, action: string, extra?: Json): string | undefined;
}

export function createKit(context: DriverContext, store: GitHubStore, git: GitStore): GitHubKit {
  const { ids, clock } = context;

  const permission = (repo: GitHubRepoRecord, user: number): GitHubPermission | undefined => {
    const app = store.appOfBot(user);
    if (app) return repo.apps.has(app.name) ? "write" : undefined;
    const person = store.users.find(String(user));
    if (!person) return undefined;
    if (person.role === "admin") return "admin";
    const listed = repo.collaborators.get(person.login);
    // An org member can read every repository of the org; anything more needs to be granted.
    return listed ?? (person.role === "member" || !repo.private ? "read" : undefined);
  };

  const objects = githubObjects({
    url: context.apiUrl,
    org: () => store.org,
    app: () => store.app,
    appNamed: (name) => store.appNamed(name),
    appOfBot: (id) => store.appOfBot(id),
    actor: (id) => store.actor(id),
    repo: (id) => store.repo(id),
    commentCount: (issue) => store.commentsOn(store.repo(issue.repo), issue.number).length,
    reviewCommentCount: (issue) => store.postedReviewComments(store.repo(issue.repo), issue.number).length,
    openIssueCount: (repo) => store.issuesOf(repo).filter((issue) => issue.state === "open").length,
    association: (repo, user) => {
      if (store.appOfBot(user)) return "NONE";
      const person = store.users.find(String(user));
      if (person?.role === "admin" || person?.role === "member") return "MEMBER";
      return person && repo.collaborators.has(person.login) ? "COLLABORATOR" : "NONE";
    },
  });

  // GitHub doesn't retry a delivery the App didn't acknowledge: it only redelivers when asked.
  const deliveries = deliveryKit(context, {
    driver: "github",
    timeoutMs: ACK_WINDOW_MS,
    // The hook and its target are the receiving App's: each App's webhook is its own.
    sign: (secret, body, _atMs, { id, type, app }) => {
      const target = String(store.appNamed(app).id);
      return {
        "user-agent": "GitHub-Hookshot/0a1b2c3",
        "x-github-delivery": id,
        "x-github-event": type,
        "x-github-hook-id": target,
        "x-github-hook-installation-target-id": target,
        "x-github-hook-installation-target-type": "integration",
        ...signGitHubWebhook(secret, body),
      };
    },
    secret: (app) => context.apps.secret(app, "webhookSecret"),
  });

  /** Send one App its own delivery of an event: its own GUID, its installation, its secret, its URL. */
  const emitTo = (
    app: GitHubAppRecord,
    repo: GitHubRepoRecord,
    event: string,
    sender: number | "org",
    payload: Json,
  ): string | undefined => {
    const url = context.apps.webhookUrl(app.name);
    if (url === undefined) return undefined;
    const installing = event === "installation_repositories";
    const session = store.sessionOf(repo);
    const guid = ids.next(GITHUB_IDS.delivery);
    const full = {
      ...payload,
      ...(installing ? {} : { repository: objects.propertiedRepository(repo) }),
      organization: objects.organization(),
      // What an org owner does to the App's installation comes from the org itself in the fake.
      sender: sender === "org" ? objects.orgOwner() : objects.actor(sender),
      installation: installing ? payload.installation : objects.installationLite(app),
    };
    const action = typeof payload.action === "string" ? payload.action : null;
    store.hookDeliveries.push({
      id: Number(ids.next(GITHUB_IDS.hookDelivery)),
      app: app.name,
      guid,
      session,
      event,
      action,
      repo: repo.id,
      deliveredAt: clock(),
    });
    deliveries.send({
      id: guid,
      session,
      app: app.name,
      type: event,
      url,
      body: JSON.stringify(full),
      meta: {
        eventType: action === null ? event : `${event}.${action}`,
        action,
        payload: full,
        repo: repo.id,
        app: app.name,
      },
    });
    return guid;
  };

  const emit: GitHubKit["emit"] = (repo, event, sender, payload, only) => {
    // An App hears about a repository it is installed on, for the events it subscribed to. Being
    // added to or removed from one is the exception: GitHub sends that to the App it concerns.
    // Its own actions come back to it too: GitHub has no GITHUB_TOKEN-style suppression for Apps.
    const installing = event === "installation_repositories";
    const hears = (app: GitHubAppRecord) => installing || (repo.apps.has(app.name) && app.events.includes(event));
    const targets = (only ? [only] : store.apps.all()).filter(hears);
    const sent = new Map(targets.map((app) => [app.name, emitTo(app, repo, event, sender, payload)]));
    return sent.get((only ?? store.app).name);
  };

  const requireIssue: GitHubKit["requireIssue"] = (repo, number) => {
    const issue = store.issue(repo, number);
    if (!issue) throw new GitHubRefusal(404, "Not Found");
    return issue;
  };

  const kit: GitHubKit = {
    context,
    store,
    git,
    deliveries,
    objects,
    dir: (repo) => `/${repo.id}`,
    action: (repo, name, data) =>
      context.events.append(store.sessionOf(repo), "github", "action", { action: name, ...data }),
    emit,
    can: (repo, user, level) => {
      const has = permission(repo, user);
      return has !== undefined && PERMISSIONS.indexOf(has) >= PERMISSIONS.indexOf(level);
    },
    allow(repo, user, level) {
      // GitHub answers 404 for a repository you can't see at all, and 403 for one you can't change.
      if (permission(repo, user) === undefined) throw new GitHubRefusal(404, "Not Found");
      if (!kit.can(repo, user, level)) {
        throw new GitHubRefusal(403, `Must have ${level} access to ${repo.owner}/${repo.name}.`);
      }
    },
    allowApp(repo, app, [name, level]) {
      // A repository the App isn't installed on doesn't exist for its token.
      if (!repo?.apps.has(app.name)) throw new GitHubRefusal(404, "Not Found");
      const granted = name === "metadata" ? "read" : app.permissions[name];
      if (granted === undefined || (level === "write" && granted !== "write")) {
        throw new GitHubRefusal(403, "Resource not accessible by integration");
      }
      return repo;
    },
    requireIssue,
    requirePull(repo, number) {
      const issue = requireIssue(repo, number);
      if (!issue.pull) throw new GitHubRefusal(404, "Not Found");
      return issue as ReturnType<GitHubKit["requirePull"]>;
    },
    identity: (user) => ({
      name: user.name ?? user.login,
      email: user.email ?? `${user.id}+${user.login}@users.noreply.github.com`,
    }),
    touch(issue) {
      issue.updatedAt = clock();
    },
    wrote(repo, number, sender) {
      const session = store.sessionOf(repo);
      if (session === undefined) return true;
      const app = store.appOfBot(sender);
      return context.loops.wrote(
        session,
        `${repo.id}#${number}`,
        app ? { kind: "app", name: app.slug } : { kind: "person" },
      );
    },
    issueEvent(issue, sender, action, extra = {}) {
      const repo = store.repo(issue.repo);
      if (!kit.wrote(repo, issue.number, sender)) return undefined;
      return issue.pull
        ? emit(repo, "pull_request", sender, {
            action,
            number: issue.number,
            pull_request: objects.pullRequest(issue),
            ...extra,
          })
        : emit(repo, "issues", sender, { action, issue: objects.issue(issue), ...extra });
    },
  };
  return kit;
}
