import { ProtocolError } from "../../../core/errors/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { signGitHubWebhook } from "../../../core/signing/github.ts";
import { GITHUB_IDS } from "../ids.ts";
import { type GitHubObjects, githubObjects } from "../payloads.ts";
import {
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
   * Send a webhook about a repository to the App, if it is installed there, subscribed to the
   * event and reachable. Answers with the delivery's GUID, or nothing when nothing was sent.
   */
  emit(repo: GitHubRepoRecord, event: string, sender: number | "org", payload: Json): string | undefined;
  /** The headers GitHub puts on a delivery, signed with `secret` over these exact bytes. */
  headers(event: string, guid: string, body: string, secret: string): Record<string, string>;
  /** May this person do something that needs `level` on the repository? The App's bot may, where it is installed. */
  can(repo: GitHubRepoRecord, user: number, level: GitHubPermission): boolean;
  /** Refuse unless they may. */
  allow(repo: GitHubRepoRecord, user: number, level: GitHubPermission): void;
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
  /** `issues` for an issue, `pull_request` for a pull request, with the object under the matching key. */
  issueEvent(issue: GitHubIssueRecord, sender: number, action: string, extra?: Json): string | undefined;
}

export function createKit(context: DriverContext, store: GitHubStore, git: GitStore): GitHubKit {
  const { ids, clock, delivery } = context;

  const permission = (repo: GitHubRepoRecord, user: number): GitHubPermission | undefined => {
    if (user === store.bot.id) return repo.installed ? "write" : undefined;
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
    actor: (id) => store.actor(id),
    repo: (id) => store.repo(id),
    commentCount: (issue) => store.commentsOn(store.repo(issue.repo), issue.number).length,
    reviewCommentCount: (issue) => store.postedReviewComments(store.repo(issue.repo), issue.number).length,
    openIssueCount: (repo) => store.issuesOf(repo).filter((issue) => issue.state === "open").length,
    association: (repo, user) => {
      if (user === store.bot.id) return "NONE";
      const person = store.users.find(String(user));
      if (person?.role === "admin" || person?.role === "member") return "MEMBER";
      return person && repo.collaborators.has(person.login) ? "COLLABORATOR" : "NONE";
    },
  });

  const headers: GitHubKit["headers"] = (event, guid, body, secret) => ({
    "user-agent": "GitHub-Hookshot/0a1b2c3",
    "x-github-delivery": guid,
    "x-github-event": event,
    "x-github-hook-id": String(store.app.id),
    "x-github-hook-installation-target-id": String(store.app.id),
    "x-github-hook-installation-target-type": "integration",
    ...signGitHubWebhook(secret, body),
  });

  const emit: GitHubKit["emit"] = (repo, event, sender, payload) => {
    // The App hears about a repository it is installed on; being added to or removed from one is the exception.
    const about = event === "installation_repositories" || repo.installed;
    if (context.webhookUrl === undefined || !about || !store.app.events.includes(event)) return undefined;
    const session = store.sessionOf(repo);
    const guid = ids.next(GITHUB_IDS.delivery);
    const full = {
      ...payload,
      ...(event === "installation_repositories" ? {} : { repository: objects.repository(repo) }),
      organization: objects.organization(),
      // What an org owner does to the App's installation comes from the org itself in the fake.
      sender: sender === "org" ? objects.orgOwner() : objects.actor(sender),
      installation: event === "installation_repositories" ? payload.installation : objects.installationLite(),
    };
    const action = typeof payload.action === "string" ? payload.action : null;
    store.hookDeliveries.push({
      id: Number(ids.next(GITHUB_IDS.hookDelivery)),
      guid,
      session,
      event,
      action,
      repo: repo.id,
      deliveredAt: clock(),
    });
    delivery.enqueue({
      id: guid,
      session,
      driver: "github",
      type: event,
      url: context.webhookUrl,
      body: JSON.stringify(full),
      sign: (body) => headers(event, guid, body, context.secret("webhookSecret")),
      timeoutMs: ACK_WINDOW_MS,
      meta: { eventType: action === null ? event : `${event}.${action}`, action, payload: full, repo: repo.id },
    });
    return guid;
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
    objects,
    dir: (repo) => `/${repo.id}`,
    action: (repo, name, data) =>
      context.events.append(store.sessionOf(repo), "github", "action", { action: name, ...data }),
    emit,
    headers,
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
    issueEvent(issue, sender, action, extra = {}) {
      const repo = store.repo(issue.repo);
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
