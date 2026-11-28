import { z } from "@hono/zod-openapi";

import { BUILT_IN_APP } from "../../core/apps/index.ts";
import { ProtocolError } from "../../core/errors/index.ts";
import { type EventLog, WORLD_SCOPE } from "../../core/events/index.ts";
import { type LiveSupport, unsupportedInLive } from "../../core/reality/index.ts";
import {
  type DeliveryView,
  type DriverRouter,
  fileTree,
  pathParam,
  refTo,
  registerInspectionRoutes,
} from "../../core/router/index.ts";
import {
  apiCallSchema,
  CallsQuery,
  DeliveryAttempt,
  DeliveryStatus,
  principalSchema,
  readCalls,
  transcriptSchema,
} from "../../core/router/inspect.ts";
import type { GitHubWorld } from "./backend.ts";
import { fakeGitHubWorld, mayChange } from "./fake/actions.ts";
import type { FakeGitHubWorld } from "./fake/world.ts";
import { GITHUB_API } from "./live/client.ts";
import { githubTime } from "./payloads.ts";
import { renderTranscript } from "./transcript.ts";
import {
  type GitHubAppRecord,
  type GitHubCheckRunRecord,
  type GitHubCommentRecord,
  type GitHubCommitInfo,
  type GitHubIssueRecord,
  type GitHubRepoRecord,
  type GitHubReviewCommentRecord,
  type GitHubReviewRecord,
  type GitHubUserRecord,
  REACTIONS,
} from "./world.ts";

const numberParam = (name: string) =>
  z.coerce
    .number()
    .int()
    .openapi({ param: { name, in: "path" }, type: "integer" });

const GitHubUser = z
  .object({
    id: z.string(),
    name: z.string().openapi({ description: "The login: what an author is matched by." }),
    kind: z.literal("user"),
    login: z.string(),
    numericId: z.number().int(),
    displayName: z.string().optional(),
    email: z.string().optional(),
    role: z.enum(["member", "admin", "outside_collaborator"]),
  })
  .openapi("GitHubUser", { "x-channelstack-resource": { id: "id", role: "user" } });

const GitHubApp = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.literal("app"),
    slug: z.string(),
    botLogin: z.string(),
    botUserId: z.string(),
    appId: z.number().int(),
    privateKey: z.string(),
    webhookSecret: z.string(),
  })
  .openapi("GitHubApp", { "x-channelstack-resource": { id: "id", role: "app" } });

const GitHubAuthor = z.discriminatedUnion("kind", [GitHubUser, GitHubApp]);

const GitHubRepo = z
  .object({
    id: z.string(),
    owner: z.string(),
    name: z.string(),
    fullName: z.string(),
    defaultBranch: z.string(),
    private: z.boolean(),
  })
  .openapi("GitHubRepo", { "x-channelstack-resource": { id: "id", role: "resource" } });

const GitHubDelivery = z
  .object({
    id: z.string(),
    channel: z.literal("github"),
    app: z.string().openapi({ description: "The App it went to, by name: `my-agent`, or one a test made." }),
    type: z.string().openapi({ description: "`X-GitHub-Event`, e.g. `issue_comment`." }),
    action: z.string().optional(),
    guid: z.string().openapi({ description: "`X-GitHub-Delivery`." }),
    payload: z.unknown(),
    attempts: z.array(DeliveryAttempt),
    status: DeliveryStatus,
  })
  .openapi("GitHubDelivery", { "x-channelstack-resource": { id: "id" } });

const issueShape = {
  repoId: z.string(),
  number: z.number().int(),
  repo: GitHubRepo,
  url: z.string(),
  author: GitHubAuthor,
};
const issueId = ["repoId", "number"];

const GitHubIssue = z.object(issueShape).openapi("GitHubIssue", { "x-channelstack-resource": { id: issueId } });

const GitHubPullRequest = z
  .object({ ...issueShape, head: z.string(), base: z.string() })
  .openapi("GitHubPullRequest", { "x-channelstack-resource": { id: issueId, extends: "GitHubIssue" } });

const GitHubCommit = z
  .object({
    repoId: z.string(),
    sha: z.string(),
    message: z.string(),
    author: GitHubAuthor.optional().openapi({ description: "Absent when the commit's author is nobody on GitHub." }),
    branch: z.string(),
    committedAt: z.string(),
  })
  .openapi("GitHubCommit", { "x-channelstack-resource": { id: ["repoId", "sha"] } });

const GitHubComment = z
  .object({
    id: z.number().int(),
    url: z.string(),
    issue: GitHubIssue,
    author: GitHubAuthor,
    body: z.string(),
    createdAt: z.string(),
    delivery: GitHubDelivery.optional(),
  })
  .openapi("GitHubComment", { "x-channelstack-resource": { id: "id" } });

const GitHubReviewComment = z
  .object({
    id: z.number().int(),
    pr: GitHubPullRequest,
    author: GitHubAuthor,
    path: z.string(),
    line: z.number().int(),
    side: z.enum(["LEFT", "RIGHT"]),
    body: z.string(),
    delivery: GitHubDelivery.optional(),
  })
  .openapi("GitHubReviewComment", { "x-channelstack-resource": { id: "id" } });

const GitHubReview = z
  .object({
    id: z.number().int(),
    author: GitHubAuthor,
    state: z.enum(["COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED", "PENDING"]),
    body: z.string(),
    comments: z.array(GitHubReviewComment),
    delivery: GitHubDelivery.optional(),
  })
  .openapi("GitHubReview");

const GitHubCheckRun = z
  .object({
    id: z.number().int(),
    name: z.string(),
    app: z.object({ slug: z.string() }),
    headSha: z.string(),
    status: z.enum(["queued", "in_progress", "completed"]),
    conclusion: z
      .enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required"])
      .optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
    annotations: z.array(
      z.object({
        path: z.string(),
        startLine: z.number().int(),
        endLine: z.number().int(),
        level: z.enum(["notice", "warning", "failure"]),
        message: z.string(),
      }),
    ),
    actions: z.array(z.string()).openapi({ description: "The identifiers of the buttons the App put on the run." }),
  })
  .openapi("GitHubCheckRun", { "x-channelstack-resource": { id: "id" } });

const Principal = principalSchema("GitHubPrincipal");

const GitHubTranscript = transcriptSchema("GitHub", Principal);

const GitHubApiCall = apiCallSchema("github", "GitHubApiCall");

const GitHubFixture = z
  .object({ app: GitHubApp, apiUrl: z.string(), org: z.string() })
  .openapi("GitHubFixture", { "x-channelstack-resource": {} });

const userRef = z.string().openapi(refTo("GitHubUser"));
const authorRef = z.string().openapi(refTo("GitHubUser", "GitHubApp"));
/** One author or several: `ana.assign(ben, …)` and `ana.assign([ben, github.app], …)` both work. */
const authors = () => z.array(authorRef).min(1).openapi({ "x-channelstack-one-or-many": true });
const repoRef = z.string().openapi(refTo("GitHubRepo"));
const issueRef = z.object({ repoId: z.string(), number: z.number().int() }).openapi(refTo("GitHubIssue"));
const pullRef = z.object({ repoId: z.string(), number: z.number().int() }).openapi(refTo("GitHubPullRequest"));
const commentRef = z.number().int().openapi(refTo("GitHubComment", "GitHubReviewComment"));
const reviewCommentRef = z.number().int().openapi(refTo("GitHubReviewComment"));
const checkRunRef = z.number().int().openapi(refTo("GitHubCheckRun"));

/** Changes to a branch: files with their new contents, or `null` for a file that goes away. */
const changes = () =>
  z
    .array(z.object({ path: z.string().min(1), content: z.string().nullable() }))
    .openapi({ "x-channelstack-files": "changes" });

const UserParams = z.object({ user: pathParam("user") });
const AppParams = z.object({ app: pathParam("app") });
const RepoParams = z.object({ repo: pathParam("repo") });
const IssueParams = RepoParams.extend({ number: numberParam("number") });
const CommitParams = RepoParams.extend({ sha: pathParam("sha") });
const issueBinding = { repo: "repoId", number: "number" };
const commitBinding = { repo: "repoId", sha: "sha" };

/** A person's Re-run is a click in GitHub: `rerequest` answers 403 to anyone but the App that owns the check run. */
const RERUN: LiveSupport = {
  unsupported: "not yet: a person's Re-run is a click in GitHub's UI, and the API lets only the owning App rerequest",
};
/** The requested-action buttons on a check run send their webhook only when a person clicks them. */
const IN_THE_UI: LiveSupport = { requires: "browser", reason: "GitHub sends this only when a person clicks in the UI" };
/** Pull requests, reviews, pushes, checks and installs aren't built live yet. */
const NOT_YET: LiveSupport = {
  unsupported: "not yet: pull requests, reviews, pushes, checks and installs aren't built live",
};
/** Live, the org holds only the App channelstack has credentials for (decision 0027's live Apps aren't built yet). */
const APPS_NOT_YET: LiveSupport = {
  unsupported: "not yet: live, the org holds only the App channelstack has credentials for",
};

/** What an App's installation needs for what it does: GitHub refuses it with 403 without. */
type Needs = readonly [permission: string, level: "read" | "write"];
const ISSUES: Needs = ["issues", "write"];
const PULLS: Needs = ["pull_requests", "write"];
const CONTENTS: Needs = ["contents", "write"];

/**
 * Who acts in a route of what people do: a person of the session (`/users/{user}/…`, on
 * `GitHubUser`), or an App a test made (`/apps/{app}/…`, on `GitHubApp`), which acts through the
 * fake's own code path as its bot, with what its installation may do (decision 0027).
 */
const ACTORS = [
  { kind: "user", on: "GitHubUser", prefix: "/users/{user}", params: UserParams },
  { kind: "app", on: "GitHubApp", prefix: "/apps/{app}", params: AppParams },
] as const;
type Actor = (typeof ACTORS)[number];

/** What only the App's own calls show: live, proxy mode sees them. */
const AGENT_SIDE: LiveSupport = {
  requires: "proxy",
  reason: "GitHub doesn't report the App's calls; proxy mode sees them",
};

/** The GitHub driver's control API: what a test's people do, and what a test reads back. */
export function registerGitHubRoutes(
  router: DriverRouter,
  deps: {
    fake: FakeGitHubWorld;
    /** The live world, on a live driver. */
    live: GitHubWorld | undefined;
    events: EventLog;
    apiUrl: () => string;
    /** One of an App's secrets: the built-in App's unless another is named. */
    secret: (name: string, app?: string) => string;
  },
): void {
  const { fake } = deps;
  const { kit, repos, issues, pulls, checks } = fake;
  const { git } = kit;
  const fakeWorld = fakeGitHubWorld(fake);
  /** The world a route that works live acts in. Routes that don't are refused live by the router, and use the fake. */
  const world: GitHubWorld = deps.live ?? fakeWorld;
  const isLive = deps.live !== undefined;
  const { store } = world;
  /** What a person did, on the session's timeline. */
  const record = (session: string, name: string, data: Record<string, unknown>) =>
    deps.events.append(session, "github", "action", { action: name, ...data });
  const stability = "experimental";

  // --- Records → wire ---------------------------------------------------------------------------

  /** An issue of a repository in the world's store: the fake's, or the live mirror. */
  const issueIn = (repo: GitHubRepoRecord, number: number) => {
    const issue = store.issue(repo, number);
    if (!issue) throw new ProtocolError("not_found", `No issue or pull request #${number} in that repository`);
    return issue;
  };

  const userWire = (user: GitHubUserRecord) => ({
    id: String(user.id),
    name: user.login,
    kind: "user" as const,
    login: user.login,
    numericId: user.id,
    displayName: user.name,
    email: user.email,
    role: user.role,
  });
  const appWire = (app: GitHubAppRecord = store.app) => {
    const bot = store.botOf(app);
    return {
      id: String(app.id),
      name: app.name,
      kind: "app" as const,
      slug: app.slug,
      botLogin: bot.login,
      botUserId: String(bot.id),
      appId: app.id,
      // A live App's credentials stay on the server: the control API never returns them.
      privateKey: isLive ? "" : deps.secret("privateKey", app.name),
      webhookSecret: isLive ? "" : deps.secret("webhookSecret", app.name),
    };
  };
  const authorWire = (id: number) => {
    const app = store.appOfBot(id);
    return app ? appWire(app) : userWire(store.actor(id));
  };
  const principal = (id: number) => {
    const { id: principalId, name, kind } = authorWire(id);
    return { id: principalId, name, kind };
  };
  const repoWire = (repo: GitHubRepoRecord) => ({
    id: String(repo.id),
    owner: repo.owner,
    name: repo.name,
    fullName: `${repo.owner}/${repo.name}`,
    defaultBranch: repo.defaultBranch,
    private: repo.private,
  });
  const issueWire = (issue: GitHubIssueRecord) => {
    const repo = store.repo(issue.repo);
    return {
      repoId: String(repo.id),
      number: issue.number,
      repo: repoWire(repo),
      url: `${world.repoWeb(repo)}/${issue.pull ? "pull" : "issues"}/${issue.number}`,
      author: authorWire(issue.author),
    };
  };
  const pullWire = (issue: GitHubIssueRecord) => ({
    ...issueWire(issue),
    head: issue.pull?.head ?? "",
    base: issue.pull?.base ?? "",
  });
  const deliveryWire = ({ request, attempts }: DeliveryView) => ({
    id: request.id,
    channel: "github" as const,
    // Live, a delivery is read from the built-in App's log on GitHub; the fake says which App it went to.
    app: typeof request.meta?.app === "string" ? request.meta.app : BUILT_IN_APP,
    type: request.type,
    action: typeof request.meta?.action === "string" ? request.meta.action : undefined,
    guid: request.id,
    payload: request.meta?.payload,
    attempts,
    status: attempts.at(-1)?.status ?? ("pending" as const),
  });
  /** The delivery an action caused, when the App could be told. */
  const caused = (session: string, guid: string | undefined) =>
    guid === undefined ? null : deliveryWire(fake.delivery(session, guid));
  const delivered = (session: string, guids: ReadonlyArray<string | undefined>) =>
    guids.flatMap((guid) => (guid === undefined ? [] : [deliveryWire(fake.delivery(session, guid))]));
  const commentWire = (session: string, comment: GitHubCommentRecord) => {
    const repo = store.repo(comment.repo);
    const issue = issueIn(repo, comment.issue);
    return {
      id: comment.id,
      url: `${issueWire(issue).url}#issuecomment-${comment.id}`,
      issue: issueWire(issue),
      author: authorWire(comment.author),
      body: comment.body,
      createdAt: githubTime(comment.createdAt),
      delivery: caused(session, comment.delivery) ?? undefined,
    };
  };
  const reviewCommentWire = (session: string, comment: GitHubReviewCommentRecord) => ({
    id: comment.id,
    pr: pullWire(kit.requirePull(store.repo(comment.repo), comment.pull)),
    author: authorWire(comment.author),
    path: comment.path,
    line: comment.line,
    side: comment.side,
    body: comment.body,
    delivery: caused(session, comment.delivery) ?? undefined,
  });
  const reviewWire = (session: string, review: GitHubReviewRecord) => ({
    id: review.id,
    author: authorWire(review.author),
    state: review.state,
    body: review.body,
    comments: store
      .reviewCommentsOf(store.repo(review.repo), review.pull)
      .filter((comment) => comment.review === review.id)
      .map((comment) => reviewCommentWire(session, comment)),
    delivery: caused(session, review.delivery) ?? undefined,
  });
  const checkRunWire = (run: GitHubCheckRunRecord) => ({
    id: run.id,
    name: run.name,
    app: { slug: store.appNamed(run.app).slug },
    headSha: run.headSha,
    status: run.status,
    conclusion: run.conclusion,
    title: run.title,
    summary: run.summary,
    annotations: run.annotations.map((annotation) => ({
      path: annotation.path,
      startLine: annotation.start_line,
      endLine: annotation.end_line,
      level: annotation.annotation_level,
      message: annotation.message,
    })),
    actions: run.actions.map((action) => action.identifier),
  });
  const commitWire = (repo: GitHubRepoRecord, info: GitHubCommitInfo, branch: string) => {
    const author = repos.commitAuthor(repo, info);
    return {
      repoId: String(repo.id),
      sha: info.sha,
      message: info.message,
      author: author ? authorWire(author.id) : undefined,
      branch,
      committedAt: githubTime(info.committer.date),
    };
  };

  // --- Handles → records ------------------------------------------------------------------------

  const person = (session: string, id: string) => store.users.get(session, id).id;
  /**
   * The people, or the App's bot, an issue is assigned to or a review is requested from. The
   * SDK takes the App here (`ana.assign(github.app, { issue })`); whether GitHub itself accepts an App's bot is
   * not verified (docs/reality-matrix.md).
   */
  const people = (session: string, ids: readonly string[], operation: string) =>
    ids.map((id) => {
      const app = store.apps.all().find((candidate) => String(candidate.id) === id);
      if (!app) return person(session, id);
      // Unverified live, and likely refused: GitHub's docs don't cover an App's bot as an assignee or reviewer.
      if (isLive) throw unsupportedInLive(operation, "GitHub doesn't take an App's bot here (docs/reality-matrix.md)");
      return app.botId;
    });
  /**
   * The id someone acts as in a route of what people do, and a check of what they may do there. A
   * person may do what their role on the repository lets them (the world checks it); an App a test
   * made may do what its installation may, and never acts as the built-in App.
   */
  const actorOf = (by: Actor, session: string, params: Readonly<Record<string, string>>) => {
    if (by.kind === "user")
      return { id: person(session, params.user ?? ""), may: (_repo: GitHubRepoRecord, _needs: Needs) => {} };
    const app = store.apps.scripted(session, params.app ?? "");
    return { id: app.botId, may: (repo: GitHubRepoRecord, needs: Needs) => void kit.allowApp(repo, app, needs) };
  };
  /** The world an actor acts in: a person's works live too; a scripted App acts in the fake. */
  const worldOf = (by: Actor): GitHubWorld => (by.kind === "user" ? world : fakeWorld);
  /** What live says of a route someone acts in: a person's as given, an App's not yet. */
  const liveOf = (by: Actor, support?: LiveSupport) =>
    by.kind === "app" ? { live: APPS_NOT_YET } : support === undefined ? {} : { live: support };
  const repoOf = (session: string, id: string) => store.repos.get(session, id);
  const issueOf = (session: string, ref: { repoId: string; number: number }) => {
    const issue = store.issue(repoOf(session, ref.repoId), ref.number);
    if (!issue) throw new ProtocolError("not_found", `No issue or pull request #${ref.number} in that repository`);
    return issue;
  };
  const pullOf = (session: string, ref: { repoId: string; number: number }) => {
    const issue = issueOf(session, ref);
    if (!issue.pull) throw new ProtocolError("not_found", `#${ref.number} is an issue, not a pull request`);
    return issue as GitHubIssueRecord & { pull: NonNullable<GitHubIssueRecord["pull"]> };
  };
  /** A comment on the diff a person has a handle to: one they can see, so not one of a review that is still pending. */
  const reviewCommentOf = (session: string, id: number) => {
    const comment = store.reviewComments.get(session, String(id));
    if (store.reviews.find(String(comment.review))?.state === "PENDING") {
      throw new ProtocolError("not_found", `No comment ${id} on the diff: its review hasn't been submitted`);
    }
    return comment;
  };
  /** A conversation comment or a comment on the diff, whichever the id is. */
  const anyComment = (session: string, id: number) => {
    const review = store.reviewComments.find(String(id));
    return review && store.reviewComments.owner(String(id)) === session
      ? { review, comment: undefined }
      : { review: undefined, comment: store.comments.get(session, String(id)) };
  };
  const checkRunOf = (session: string, id: number) => store.checkRuns.get(session, String(id));
  const bytes = (content: string) => Buffer.from(content, "base64");
  const changeMap = (list: ReadonlyArray<{ path: string; content: string | null }>) =>
    new Map(list.map(({ path, content }) => [path.replace(/^\.?\//, ""), content === null ? null : bytes(content)]));

  /** The commit message GitHub's web editor suggests when none is given. */
  const defaultMessage = (list: ReadonlyArray<{ path: string }>) =>
    `Update ${list.length === 1 ? list[0]?.path : `${list.length} files`}`;

  // --- The fixture ----------------------------------------------------------------------------

  router.route({
    method: "get",
    path: "",
    summary: "The GitHub fixture: the agent's App, the org, and where the agent reaches the fake",
    response: GitHubFixture,
    factory: { on: "Session", name: "github" },
    stability,
    handler: () => ({ app: appWire(), apiUrl: isLive ? GITHUB_API : deps.apiUrl(), org: store.org.login }),
  });

  router.route({
    method: "post",
    path: "/users",
    summary: "Create a person in the org",
    body: z
      .object({
        login: z.string().min(1),
        id: z.number().int().positive().optional(),
        name: z.string().optional(),
        email: z.string().optional(),
        role: z.enum(["member", "admin", "outside_collaborator"]).optional(),
        token: z.string().min(1).optional().openapi({
          description:
            "A real machine user's token (a fine-grained or classic PAT) in the live org. Read from CHANNELSTACK_GITHUB_USER_<LOGIN>_TOKEN when left out.",
          "x-channelstack-credential": "CHANNELSTACK_GITHUB_USER_{login}_TOKEN",
        }),
      })
      .openapi("GitHubUserOptions"),
    response: GitHubUser,
    factory: {
      on: "GitHubFixture",
      name: "createUser",
      options: ["login", "id", "name", "email", "role", "token"],
    },
    stability,
    handler: async ({ session, body }) => userWire(await world.createUser(session.id, body)),
  });

  router.route({
    method: "post",
    path: "/repos",
    summary:
      "Create a repository in the org. The App hears about it only when it is listed in `apps`: an App must be installed on a repository",
    body: z
      .object({
        name: z.string().min(1).optional(),
        private: z.boolean().optional(),
        defaultBranch: z.string().min(1).optional(),
        files: fileTree().optional(),
        collaborators: z
          .array(
            z
              .object({
                user: userRef,
                permission: z.enum(["read", "triage", "write", "maintain", "admin"]).default("write"),
              })
              .openapi({ "x-channelstack-shorthand": "user" }),
          )
          .optional(),
        apps: z.array(z.string().openapi(refTo("GitHubApp"))).optional(),
        labels: z
          .array(
            z
              .object({ name: z.string().min(1), color: z.string().optional(), description: z.string().optional() })
              .openapi({ "x-channelstack-shorthand": "name" }),
          )
          .optional(),
      })
      .openapi("GitHubRepoOptions"),
    response: GitHubRepo,
    factory: {
      on: "GitHubFixture",
      name: "createRepo",
      options: ["name", "private", "defaultBranch", "files", "collaborators", "apps", "labels"],
    },
    stability,
    handler: async ({ session, body }) =>
      repoWire(
        await world.createRepo(session.id, {
          name: body.name,
          private: body.private,
          defaultBranch: body.defaultBranch,
          files: body.files?.map((file) => ({ path: file.path, content: bytes(file.content) })),
          collaborators: body.collaborators?.map(({ user, permission }) => ({
            user: person(session.id, user),
            permission,
          })),
          apps: body.apps?.map((app) => store.apps.get(session.id, app).name),
          labels: body.labels,
        }),
      ),
  });

  /** The id of an App's installation, for a repository it is installed on. */
  const installationIdOf = (session: string, repoId: string, app: GitHubAppRecord) => {
    const repo = repoOf(session, repoId);
    if (!repo.apps.has(app.name)) {
      throw new ProtocolError("not_found", `The App ${app.slug} isn't installed on ${repo.owner}/${repo.name}`);
    }
    return app.installationId;
  };

  router.route({
    method: "get",
    path: "/users",
    summary: "The people this session created",
    response: z.array(GitHubUser).openapi("GitHubUsers"),
    sdkMethod: { on: "GitHubFixture", name: "users" },
    stability,
    handler: ({ session }) => store.users.list(session.id).map(userWire),
  });

  router.route({
    method: "get",
    path: "/repos",
    summary: "The repositories this session created",
    response: z.array(GitHubRepo).openapi("GitHubRepos"),
    sdkMethod: { on: "GitHubFixture", name: "repos" },
    stability,
    handler: ({ session }) => store.repos.list(session.id).map(repoWire),
  });

  router.route({
    method: "get",
    path: "/issues",
    summary:
      "The issues and pull requests in this session's repositories, read again from GitHub live, the most recently updated last",
    response: z
      .array(
        z
          .object({
            issue: GitHubIssue,
            title: z.string().openapi({ description: "Its title as it is now." }),
            pullRequest: z.boolean().openapi({ description: "It is a pull request." }),
            updatedAt: z.string().openapi({
              description:
                "When it last changed (a comment changes it too), to the millisecond: GitHub's own times are to the second.",
            }),
          })
          .openapi("GitHubIssueListing"),
      )
      .openapi("GitHubIssues"),
    sdkMethod: { on: "GitHubFixture", name: "issues" },
    stability,
    handler: async ({ session }) => {
      const issues = store.issues.list(session.id);
      for (const issue of issues) await world.refresh(session.id, issue);
      // A comment updates its issue, as on GitHub: the most recently active is listed last.
      return issues
        .toSorted((a, b) => a.updatedAt - b.updatedAt)
        .map((issue) => ({
          issue: issueWire(issue),
          title: issue.title,
          pullRequest: issue.pull !== undefined,
          updatedAt: new Date(issue.updatedAt).toISOString(),
        }));
    },
  });

  router.route({
    method: "post",
    path: "/installation-id",
    summary: "The id of the built-in App's installation, for a repository it is installed on",
    body: z.object({ repo: repoRef }).openapi("GitHubInstallationIdBody"),
    response: z.number().int(),
    errors: ["not_found"],
    sdkMethod: { on: "GitHubFixture", name: "installationId", args: ["repo"] },
    stability,
    handler: ({ session, body }) => installationIdOf(session.id, body.repo, store.app),
  });

  router.route({
    method: "post",
    path: "/apps/{app}/installation-id",
    summary: "The id of this App's installation, for a repository it is installed on",
    params: AppParams,
    body: z.object({ repo: repoRef }).openapi("GitHubAppInstallationIdBody"),
    response: z.number().int(),
    errors: ["not_found"],
    sdkMethod: { on: "GitHubApp", name: "installationId", args: ["repo"] },
    stability,
    handler: ({ session, params, body }) =>
      installationIdOf(session.id, body.repo, store.apps.get(session.id, params.app)),
  });

  // --- Apps -------------------------------------------------------------------------------------

  router.route({
    method: "post",
    path: "/apps",
    summary:
      "Make another GitHub App on the org, with its own App id, bot user, installation, private key and webhook secret (decision 0027), or return the one made with this name and settings. It reaches no repository until it is installed on one; its webhooks go to CHANNELSTACK_GITHUB_APP_<NAME>_WEBHOOK_URL",
    body: z
      .object({
        name: z.string().min(1).openapi({
          description: "Its slug, and its bot's login before `[bot]`: 1 to 32 lower-case letters, digits and hyphens",
        }),
        permissions: z
          .record(z.string(), z.enum(["read", "write"]))
          .optional()
          .openapi({
            description: 'What its installation may do, e.g. `{ issues: "write" }`. Default: the built-in App\'s',
          }),
        events: z
          .array(z.string())
          .optional()
          .openapi({ description: "The webhook events it subscribes to. Default: the built-in App's" }),
      })
      .openapi("GitHubAppOptions"),
    response: GitHubApp,
    errors: ["invalid_argument"],
    factory: { on: "GitHubFixture", name: "createApp", options: ["name", "permissions", "events"] },
    live: APPS_NOT_YET,
    stability,
    handler: ({ session, body }) => appWire(fake.createApp(session.id, body)),
  });

  router.route({
    method: "get",
    path: "/apps",
    summary: "The org's Apps: the built-in one first, then the others in the order they were made",
    response: z.array(GitHubApp).openapi("GitHubApps"),
    sdkMethod: { on: "GitHubFixture", name: "apps" },
    stability,
    handler: () => (isLive ? [appWire()] : fake.apps().map((app) => appWire(app))),
  });

  // --- Repositories -----------------------------------------------------------------------------

  for (const [path, name, installed] of [
    ["install", "installApp", true],
    ["uninstall", "uninstallApp", false],
  ] as const) {
    router.route({
      method: "post",
      path: `/repos/{repo}/${path}`,
      summary: installed
        ? "Install an App on this repository. Sends that App `installation_repositories`"
        : "Take an App off this repository. Sends that App `installation_repositories`",
      params: RepoParams,
      body: z
        .object({ app: z.string().openapi(refTo("GitHubApp")) })
        .openapi(`GitHub${installed ? "Install" : "Uninstall"}Body`),
      response: GitHubDelivery.nullable(),
      errors: ["not_found", "validation_failed"],
      sdkMethod: { on: "GitHubRepo", name, args: ["app"] },
      live: NOT_YET,
      stability,
      handler: ({ session, params, body }) =>
        caused(
          session.id,
          repos.setInstalled(repoOf(session.id, params.repo), store.apps.get(session.id, body.app), installed),
        ),
    });
  }

  router.route({
    method: "get",
    path: "/repos/{repo}/issue",
    summary: "An issue of this repository by its number",
    params: RepoParams,
    query: z.object({
      number: z.coerce
        .number()
        .int()
        .openapi({ param: { name: "number", in: "query", required: true }, type: "integer" }),
    }),
    response: GitHubIssue,
    errors: ["not_found"],
    sdkMethod: { on: "GitHubRepo", name: "issue", args: ["number"] },
    stability,
    handler: ({ session, params, query }) =>
      issueWire(issueOf(session.id, { repoId: params.repo, number: query.number })),
  });

  router.route({
    method: "get",
    path: "/repos/{repo}/pull",
    summary: "A pull request of this repository by its number",
    params: RepoParams,
    query: z.object({
      number: z.coerce
        .number()
        .int()
        .openapi({ param: { name: "number", in: "query", required: true }, type: "integer" }),
    }),
    response: GitHubPullRequest,
    errors: ["not_found"],
    sdkMethod: { on: "GitHubRepo", name: "pullRequest", args: ["number"] },
    live: NOT_YET,
    stability,
    handler: ({ session, params, query }) =>
      pullWire(pullOf(session.id, { repoId: params.repo, number: query.number })),
  });

  router.route({
    method: "get",
    path: "/repos/{repo}/file",
    summary: "A file's text as it is on a branch (the default branch without `ref`), or nothing when it isn't there",
    params: RepoParams,
    query: z.object({
      path: z.string().openapi({ param: { name: "path", in: "query" } }),
      ref: z
        .string()
        .optional()
        .openapi({ param: { name: "ref", in: "query" } }),
    }),
    response: z.string().nullable(),
    errors: ["not_found"],
    // The agent writes files after it hears about something: read once it has gone quiet.
    sdkMethod: { on: "GitHubRepo", name: "readFile", args: ["path"], options: ["ref"], onceQuiet: true },
    stability,
    handler: async ({ session, params, query }) => {
      const content = await world.readFile(repoOf(session.id, params.repo), query.path, query.ref);
      return content === undefined ? null : Buffer.from(content).toString("utf8");
    },
  });

  router.route({
    method: "get",
    path: "/repos/{repo}/commits",
    summary: "The commits of a branch (the default branch without `branch`), newest first",
    params: RepoParams,
    query: z.object({
      branch: z
        .string()
        .optional()
        .openapi({ param: { name: "branch", in: "query" } }),
    }),
    response: z.array(GitHubCommit).openapi("GitHubCommits"),
    errors: ["not_found"],
    sdkMethod: { on: "GitHubRepo", name: "commits", options: ["branch"] },
    live: NOT_YET,
    stability,
    handler: async ({ session, params, query }) => {
      const repo = repoOf(session.id, params.repo);
      const branch = query.branch ?? repo.defaultBranch;
      const tip = await git.branch(kit.dir(repo), branch);
      if (!tip) throw new ProtocolError("not_found", `No branch "${branch}" in ${repo.owner}/${repo.name}`);
      return (await git.log(kit.dir(repo), tip)).map((info) => commitWire(repo, info, branch));
    },
  });

  router.route({
    method: "get",
    path: "/repos/{repo}/commits/{sha}/check-runs",
    summary: "The check runs on this commit: the newest of each name",
    params: CommitParams,
    response: z.array(GitHubCheckRun).openapi("GitHubCheckRuns"),
    errors: ["not_found"],
    sdkMethod: { on: "GitHubCommit", name: "checkRuns", bind: commitBinding },
    live: NOT_YET,
    stability,
    handler: ({ session, params }) => checks.latest(repoOf(session.id, params.repo), params.sha).map(checkRunWire),
  });

  router.route({
    method: "get",
    path: "/repos/{repo}/commits/{sha}/statuses",
    summary: "The commit statuses on this commit: the newest of each context",
    params: CommitParams,
    response: z
      .array(
        z.object({
          context: z.string(),
          state: z.enum(["pending", "success", "failure", "error"]),
          author: GitHubAuthor,
        }),
      )
      .openapi("GitHubStatuses"),
    errors: ["not_found"],
    sdkMethod: { on: "GitHubCommit", name: "statuses", bind: commitBinding },
    live: NOT_YET,
    stability,
    handler: ({ session, params }) => {
      return checks.latestStatuses(repoOf(session.id, params.repo), params.sha).map((status) => ({
        context: status.context,
        state: status.state,
        author: authorWire(status.creator),
      }));
    },
  });

  // --- What people do: code ---------------------------------------------------------------------

  // Each of what people do below is there for a person and, the same, for an App a test made.
  for (const by of ACTORS) {
    router.route({
      method: "post",
      path: `${by.prefix}/push`,
      summary:
        "Push a commit to a branch (created from the default branch if it isn't there). Sends `push`, and `pull_request` `synchronize` for open pull requests from it",
      params: by.params,
      body: z
        .object({ changes: changes(), repo: repoRef, branch: z.string().min(1), message: z.string().optional() })
        .openapi("GitHubPushBody"),
      response: GitHubCommit,
      errors: ["not_found", "forbidden"],
      sdkMethod: { on: by.on, name: "push", args: ["changes"], options: ["repo", "branch", "message"] },
      ...liveOf(by, NOT_YET),
      stability,
      handler: async ({ session, params, body }) => {
        const repo = repoOf(session.id, body.repo);
        const who = actorOf(by, session.id, params);
        const actor = who.id;
        who.may(repo, CONTENTS);
        kit.allow(repo, actor, "write");
        kit.action(repo, "push", { user: actor, branch: body.branch });
        const message = body.message ?? defaultMessage(body.changes);
        const { sha } = await repos.commitTo(repo, actor, body.branch, changeMap(body.changes), message);
        const info = await git.readCommit(kit.dir(repo), sha);
        if (!info) throw new ProtocolError("internal", "The commit that was just made is gone");
        return commitWire(repo, info, body.branch);
      },
    });

    // --- What people do: issues and pull requests -----------------------------------------------------

    router.route({
      method: "post",
      path: `${by.prefix}/issues`,
      summary: "Open an issue. Sends `issues` (action `opened`)",
      params: by.params,
      body: z
        .object({
          issue: z.object({
            title: z.string().min(1),
            body: z.string().optional(),
            labels: z.array(z.string()).optional(),
            assignees: z.array(authorRef).optional(),
          }),
          repo: repoRef,
        })
        .openapi("GitHubOpenIssueBody"),
      response: GitHubIssue,
      errors: ["not_found", "forbidden", "validation_failed"],
      sdkMethod: { on: by.on, name: "openIssue", args: ["issue"], options: ["repo"] },
      ...liveOf(by),
      stability,
      handler: async ({ session, params, body }) => {
        const repo = repoOf(session.id, body.repo);
        const who = actorOf(by, session.id, params);
        const actor = who.id;
        who.may(repo, ISSUES);
        const issue = await worldOf(by).openIssue(repo, actor, {
          title: body.issue.title,
          body: body.issue.body,
          labels: body.issue.labels,
          assignees: people(
            session.id,
            body.issue.assignees ?? [],
            "GitHubUser.openIssue({ assignees: [github.app] })",
          ),
        });
        record(session.id, "openIssue", { user: actor, title: body.issue.title });
        return issueWire(issue);
      },
    });

    router.route({
      method: "post",
      path: `${by.prefix}/pulls`,
      summary:
        "Open a pull request. With `changes`, they are pushed to `from` first; without, `from` is an existing branch. Sends `pull_request` (action `opened`)",
      params: by.params,
      body: z
        .object({
          pr: z.object({
            from: z.string().min(1),
            to: z.string().optional(),
            title: z.string().optional(),
            body: z.string().optional(),
            changes: changes().optional(),
            draft: z.boolean().optional(),
            reviewers: z.array(authorRef).optional(),
          }),
          repo: repoRef,
        })
        .openapi("GitHubOpenPullRequestBody"),
      response: GitHubPullRequest,
      errors: ["not_found", "forbidden", "validation_failed"],
      sdkMethod: { on: by.on, name: "openPullRequest", args: ["pr"], options: ["repo"] },
      ...liveOf(by, NOT_YET),
      stability,
      handler: async ({ session, params, body }) => {
        const repo = repoOf(session.id, body.repo);
        const who = actorOf(by, session.id, params);
        const actor = who.id;
        const { pr } = body;
        who.may(repo, PULLS);
        if (pr.changes) who.may(repo, CONTENTS);
        kit.allow(repo, actor, pr.changes ? "write" : "read");
        // Refused before anything is pushed or opened.
        const reviewers = people(session.id, pr.reviewers ?? [], "GitHubUser.openPullRequest({ reviewers })");
        pulls.mayRequest(actor, reviewers);
        kit.action(repo, "openPullRequest", { user: actor, from: pr.from });
        if (pr.changes) {
          const message = pr.title ?? defaultMessage(pr.changes);
          await repos.commitTo(repo, actor, pr.from, changeMap(pr.changes), message);
        }
        const { issue } = await pulls.openPull(repo, actor, {
          head: pr.from,
          base: pr.to,
          title: pr.title,
          body: pr.body,
          draft: pr.draft,
        });
        if (reviewers.length > 0) pulls.requestReviewers(issue, actor, reviewers);
        return pullWire(issue);
      },
    });

    router.route({
      method: "post",
      path: `${by.prefix}/edit-issue`,
      summary:
        "Edit the title or the body of an issue or a pull request. Sends `issues` or `pull_request` (action `edited`)",
      params: by.params,
      body: z
        .object({
          changes: z.object({ title: z.string().min(1).optional(), body: z.string().optional() }),
          issue: issueRef,
        })
        .openapi("GitHubEditIssueBody"),
      response: GitHubDelivery.nullable(),
      errors: ["not_found", "forbidden"],
      sdkMethod: { on: by.on, name: "editIssue", args: ["changes"], options: ["issue"] },
      ...liveOf(by),
      stability,
      handler: async ({ session, params, body }) => {
        const issue = issueOf(session.id, body.issue);
        const who = actorOf(by, session.id, params);
        const actor = who.id;
        who.may(store.repo(issue.repo), issue.pull ? PULLS : ISSUES);
        const sent = await worldOf(by).updateIssue(issue, actor, body.changes);
        record(session.id, "editIssue", { user: actor, number: issue.number });
        return caused(session.id, sent);
      },
    });

    for (const [path, state] of [
      ["close", "closed"],
      ["reopen", "open"],
    ] as const) {
      router.route({
        method: "post",
        path: `${by.prefix}/${path}`,
        summary: `${path === "close" ? "Close" : "Reopen"} an issue or a pull request. Sends \`issues\` or \`pull_request\` (action \`${path === "close" ? "closed" : "reopened"}\`)`,
        params: by.params,
        body: z.object({ issue: issueRef }).openapi(`GitHub${path === "close" ? "Close" : "Reopen"}Body`),
        response: GitHubDelivery.nullable(),
        errors: ["not_found", "forbidden", "validation_failed"],
        sdkMethod: { on: by.on, name: path, options: ["issue"] },
        ...liveOf(by),
        stability,
        handler: async ({ session, params, body }) => {
          const issue = issueOf(session.id, body.issue);
          const who = actorOf(by, session.id, params);
          const actor = who.id;
          who.may(store.repo(issue.repo), issue.pull ? PULLS : ISSUES);
          const sent = await worldOf(by).updateIssue(issue, actor, { state });
          record(session.id, path, { user: actor, number: issue.number });
          return caused(session.id, sent);
        },
      });
    }

    for (const name of ["label", "unlabel"] as const) {
      router.route({
        method: "post",
        path: `${by.prefix}/${name}`,
        summary:
          name === "label"
            ? "Put labels on an issue or a pull request. Sends one `labeled` event per label"
            : "Take labels off an issue or a pull request. Sends one `unlabeled` event per label",
        params: by.params,
        body: z
          .object({
            labels: z.array(z.string().min(1)).min(1).openapi({ "x-channelstack-one-or-many": true }),
            issue: issueRef,
          })
          .openapi(`GitHub${name === "label" ? "Label" : "Unlabel"}Body`),
        response: z.array(GitHubDelivery).openapi(`GitHub${name === "label" ? "Label" : "Unlabel"}Deliveries`),
        errors: ["not_found", "forbidden"],
        sdkMethod: { on: by.on, name, args: ["labels"], options: ["issue"] },
        ...liveOf(by),
        stability,
        handler: async ({ session, params, body }) => {
          const issue = issueOf(session.id, body.issue);
          const repo = store.repo(issue.repo);
          const who = actorOf(by, session.id, params);
          const actor = who.id;
          who.may(repo, ISSUES);
          // A person picks from the labels the repository has.
          const unknown = body.labels.filter((label) => !repo.labels.has(label.toLowerCase()));
          if (unknown.length > 0) {
            throw new ProtocolError(
              "not_found",
              `${repo.owner}/${repo.name} has no label ${unknown.map((label) => `"${label}"`).join(", ")}. Its labels: ${[...repo.labels.values()].map((label) => label.name).join(", ")}`,
            );
          }
          const sent = await worldOf(by).label(issue, actor, body.labels, name === "label");
          record(session.id, name, { user: actor, number: issue.number, labels: body.labels });
          return delivered(session.id, sent);
        },
      });
    }

    router.route({
      method: "post",
      path: `${by.prefix}/assign`,
      summary: "Assign people or the App's bot. Sends one `assigned` event per assignee",
      params: by.params,
      body: z.object({ assignees: authors(), issue: issueRef }).openapi("GitHubAssignBody"),
      response: z.array(GitHubDelivery).openapi("GitHubAssignDeliveries"),
      errors: ["not_found", "forbidden", "validation_failed"],
      sdkMethod: { on: by.on, name: "assign", args: ["assignees"], options: ["issue"] },
      ...liveOf(by),
      stability,
      handler: async ({ session, params, body }) => {
        // The App among the assignees is refused live before anything else.
        const assignees = people(session.id, body.assignees, "GitHubUser.assign(github.app)");
        const issue = issueOf(session.id, body.issue);
        const who = actorOf(by, session.id, params);
        const actor = who.id;
        who.may(store.repo(issue.repo), ISSUES);
        const sent = await worldOf(by).assign(issue, actor, assignees);
        record(session.id, "assign", { user: actor, number: issue.number });
        return delivered(session.id, sent);
      },
    });

    // --- What people do: the conversation -------------------------------------------------------------

    router.route({
      method: "post",
      path: `${by.prefix}/comment`,
      summary: "Comment on an issue or a pull request's conversation. Sends `issue_comment` (action `created`)",
      params: by.params,
      body: z.object({ body: z.string().min(1), issue: issueRef }).openapi("GitHubCommentBody"),
      response: GitHubComment,
      errors: ["not_found", "forbidden"],
      sdkMethod: { on: by.on, name: "comment", args: ["body"], options: ["issue"] },
      ...liveOf(by),
      stability,
      handler: async ({ session, params, body }) => {
        const issue = issueOf(session.id, body.issue);
        const who = actorOf(by, session.id, params);
        const actor = who.id;
        who.may(store.repo(issue.repo), ISSUES);
        const comment = await worldOf(by).comment(issue, actor, body.body);
        record(session.id, "comment", { user: actor, number: issue.number });
        return commentWire(session.id, comment);
      },
    });

    router.route({
      method: "post",
      path: `${by.prefix}/edit`,
      summary: "Edit a conversation comment or a comment on the diff. Sends the comment's event with action `edited`",
      params: by.params,
      body: z.object({ body: z.string().min(1), comment: commentRef }).openapi("GitHubEditBody"),
      response: GitHubDelivery.nullable(),
      errors: ["not_found", "forbidden"],
      sdkMethod: { on: by.on, name: "edit", args: ["body"], options: ["comment"] },
      ...liveOf(by),
      stability,
      handler: async ({ session, params, body }) => {
        const who = actorOf(by, session.id, params);
        const actor = who.id;
        const { review, comment } = anyComment(session.id, body.comment);
        who.may(store.repo((review ?? comment).repo), review ? PULLS : ISSUES);
        let sent: string | undefined;
        if (review) {
          // GitHub lets you edit your own comment; someone else's needs write access.
          kit.allow(store.repo(review.repo), actor, review.author === actor ? "read" : "write");
          sent = pulls.editReviewComment(kit.requirePull(store.repo(review.repo), review.pull), review, body.body);
        } else sent = await worldOf(by).editComment(comment, actor, body.body);
        record(session.id, "edit", { user: actor, comment: (review ?? comment).id });
        return caused(session.id, sent);
      },
    });

    router.route({
      method: "post",
      path: `${by.prefix}/delete`,
      summary:
        "Delete a conversation comment or a comment on the diff. Sends the comment's event with action `deleted`",
      params: by.params,
      body: z.object({ comment: commentRef }).openapi("GitHubDeleteBody"),
      response: GitHubDelivery.nullable(),
      errors: ["not_found", "forbidden"],
      sdkMethod: { on: by.on, name: "delete", options: ["comment"] },
      ...liveOf(by),
      stability,
      handler: async ({ session, params, body }) => {
        const who = actorOf(by, session.id, params);
        const actor = who.id;
        const { review, comment } = anyComment(session.id, body.comment);
        who.may(store.repo((review ?? comment).repo), review ? PULLS : ISSUES);
        let sent: string | undefined;
        if (review) {
          kit.allow(store.repo(review.repo), actor, review.author === actor ? "read" : "write");
          sent = pulls.deleteReviewComment(kit.requirePull(store.repo(review.repo), review.pull), review);
        } else sent = await worldOf(by).deleteComment(comment, actor);
        record(session.id, "delete", { user: actor, comment: (review ?? comment).id });
        return caused(session.id, sent);
      },
    });

    router.route({
      method: "post",
      path: `${by.prefix}/react`,
      summary: "React to an issue, a pull request or a comment. GitHub sends no webhook for a reaction",
      params: by.params,
      body: z
        .object({ content: z.enum(REACTIONS), issue: issueRef.optional(), comment: commentRef.optional() })
        .openapi("GitHubReactBody"),
      errors: ["not_found", "forbidden"],
      sdkMethod: { on: by.on, name: "react", args: ["content"], options: ["issue", "comment"] },
      ...liveOf(by),
      stability,
      handler: async ({ session, params, body }) => {
        const who = actorOf(by, session.id, params);
        const actor = who.id;
        if ((body.issue === undefined) === (body.comment === undefined)) {
          throw new ProtocolError("invalid_argument", "React to one thing: an issue or a comment");
        }
        const found = body.comment === undefined ? undefined : anyComment(session.id, body.comment);
        if (found?.review) {
          who.may(store.repo(found.review.repo), PULLS);
          kit.allow(store.repo(found.review.repo), actor, "read");
          issues.react(found.review, actor, body.content);
        } else {
          const target = body.issue ? issueOf(session.id, body.issue) : found?.comment;
          if (!target) throw new ProtocolError("not_found", "Nothing to react to");
          who.may(store.repo(target.repo), ISSUES);
          await worldOf(by).react(target, actor, body.content);
        }
        record(session.id, "react", { user: actor, content: body.content });
      },
    });

    router.route({
      method: "post",
      path: `${by.prefix}/minimize`,
      summary: "Hide a comment as outdated, spam, off-topic or resolved. GitHub sends no webhook for it",
      params: by.params,
      body: z
        .object({
          comment: z.number().int().openapi(refTo("GitHubComment")),
          reason: z.enum(["OUTDATED", "SPAM", "OFF_TOPIC", "RESOLVED"]).default("OUTDATED"),
        })
        .openapi("GitHubMinimizeBody"),
      errors: ["not_found", "forbidden"],
      sdkMethod: { on: by.on, name: "minimize", options: ["comment", "reason"] },
      ...liveOf(by, NOT_YET),
      stability,
      handler: ({ session, params, body }) => {
        const who = actorOf(by, session.id, params);
        const actor = who.id;
        const comment = store.comments.get(session.id, String(body.comment));
        who.may(store.repo(comment.repo), ISSUES);
        kit.allow(store.repo(comment.repo), actor, comment.author === actor ? "read" : "triage");
        kit.action(store.repo(comment.repo), "minimize", { user: actor, comment: comment.id, reason: body.reason });
        issues.minimize(comment, body.reason);
      },
    });

    // --- What people do: reviews --------------------------------------------------------------------

    router.route({
      method: "post",
      path: `${by.prefix}/review`,
      summary:
        "Submit a review, with comments on the diff if any. Sends `pull_request_review`, and one `pull_request_review_comment` per comment",
      params: by.params,
      body: z
        .object({
          review: z.object({
            pr: pullRef,
            event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
            body: z.string().optional(),
            comments: z
              .array(
                z.object({
                  path: z.string().min(1),
                  line: z.number().int().positive(),
                  side: z.enum(["LEFT", "RIGHT"]).optional(),
                  startLine: z.number().int().positive().optional(),
                  body: z.string().min(1),
                }),
              )
              .optional(),
          }),
        })
        .openapi("GitHubReviewBody"),
      response: GitHubReview,
      errors: ["not_found", "forbidden", "validation_failed"],
      sdkMethod: { on: by.on, name: "review", args: ["review"] },
      ...liveOf(by, NOT_YET),
      stability,
      handler: async ({ session, params, body }) => {
        const pull = pullOf(session.id, body.review.pr);
        const who = actorOf(by, session.id, params);
        const actor = who.id;
        who.may(store.repo(pull.repo), PULLS);
        kit.allow(store.repo(pull.repo), actor, "read");
        kit.action(store.repo(pull.repo), "review", { user: actor, number: pull.number, event: body.review.event });
        const { review } = await pulls.review(pull, actor, body.review);
        return reviewWire(session.id, review);
      },
    });

    router.route({
      method: "post",
      path: `${by.prefix}/review-comment`,
      summary: "One comment on the diff, outside a review. Sends `pull_request_review_comment`",
      params: by.params,
      body: z
        .object({
          body: z.string().min(1),
          pr: pullRef,
          path: z.string().min(1),
          line: z.number().int().positive(),
          side: z.enum(["LEFT", "RIGHT"]).optional(),
        })
        .openapi("GitHubReviewCommentBody"),
      response: GitHubReviewComment,
      errors: ["not_found", "forbidden", "validation_failed"],
      sdkMethod: { on: by.on, name: "reviewComment", args: ["body"], options: ["pr", "path", "line", "side"] },
      ...liveOf(by, NOT_YET),
      stability,
      handler: async ({ session, params, body }) => {
        const pull = pullOf(session.id, body.pr);
        const who = actorOf(by, session.id, params);
        const actor = who.id;
        who.may(store.repo(pull.repo), PULLS);
        kit.allow(store.repo(pull.repo), actor, "read");
        kit.action(store.repo(pull.repo), "reviewComment", { user: actor, number: pull.number, path: body.path });
        return reviewCommentWire(session.id, await pulls.reviewComment(pull, actor, body));
      },
    });

    router.route({
      method: "post",
      path: `${by.prefix}/reply`,
      summary: "Reply in a thread on the diff. Sends `pull_request_review_comment`",
      params: by.params,
      body: z.object({ body: z.string().min(1), comment: reviewCommentRef }).openapi("GitHubReplyBody"),
      response: GitHubReviewComment,
      errors: ["not_found", "forbidden"],
      sdkMethod: { on: by.on, name: "reply", args: ["body"], options: ["comment"] },
      ...liveOf(by, NOT_YET),
      stability,
      handler: ({ session, params, body }) => {
        const to = reviewCommentOf(session.id, body.comment);
        const pull = kit.requirePull(store.repo(to.repo), to.pull);
        const who = actorOf(by, session.id, params);
        const actor = who.id;
        who.may(store.repo(to.repo), PULLS);
        kit.allow(store.repo(to.repo), actor, "read");
        kit.action(store.repo(to.repo), "reply", { user: actor, comment: to.id });
        return reviewCommentWire(session.id, pulls.reply(pull, actor, to, body.body));
      },
    });

    for (const name of ["resolve", "unresolve"] as const) {
      router.route({
        method: "post",
        path: `${by.prefix}/${name}`,
        summary: `${name === "resolve" ? "Resolve" : "Reopen"} a thread on the diff. Sends \`pull_request_review_thread\``,
        params: by.params,
        body: z
          .object({ comment: reviewCommentRef })
          .openapi(`GitHub${name === "resolve" ? "Resolve" : "Unresolve"}Body`),
        response: GitHubDelivery.nullable(),
        errors: ["not_found", "forbidden"],
        sdkMethod: { on: by.on, name, options: ["comment"] },
        ...liveOf(by, NOT_YET),
        stability,
        handler: ({ session, params, body }) => {
          const comment = reviewCommentOf(session.id, body.comment);
          const pull = kit.requirePull(store.repo(comment.repo), comment.pull);
          const who = actorOf(by, session.id, params);
          const actor = who.id;
          who.may(store.repo(comment.repo), PULLS);
          // Whoever opened the pull request or started the thread may resolve it; anyone else needs write access.
          const own = pull.author === actor || pulls.threadOf(comment)[0]?.author === actor;
          kit.allow(store.repo(comment.repo), actor, own ? "read" : "write");
          kit.action(store.repo(comment.repo), name, { user: actor, comment: comment.id });
          return caused(session.id, pulls.setResolved(pull, actor, comment, name === "resolve"));
        },
      });
    }

    router.route({
      method: "post",
      path: `${by.prefix}/request-review`,
      summary:
        "Request a review from people or the App's bot. Sends `pull_request` (action `review_requested`) per reviewer",
      params: by.params,
      body: z.object({ reviewers: authors(), pr: pullRef }).openapi("GitHubRequestReviewBody"),
      response: GitHubDelivery.nullable(),
      errors: ["not_found", "forbidden", "validation_failed"],
      sdkMethod: { on: by.on, name: "requestReview", args: ["reviewers"], options: ["pr"] },
      ...liveOf(by, NOT_YET),
      stability,
      handler: ({ session, params, body }) => {
        const pull = pullOf(session.id, body.pr);
        const who = actorOf(by, session.id, params);
        const actor = who.id;
        who.may(store.repo(pull.repo), PULLS);
        mayChange(kit, pull, actor);
        kit.action(store.repo(pull.repo), "requestReview", { user: actor, number: pull.number });
        const sent = pulls.requestReviewers(
          pull,
          actor,
          people(session.id, body.reviewers, "GitHubUser.requestReview"),
        );
        return caused(
          session.id,
          sent.find((guid) => guid !== undefined),
        );
      },
    });

    router.route({
      method: "post",
      path: `${by.prefix}/mark-ready`,
      summary: "Mark a draft pull request as ready for review. Sends `pull_request` (action `ready_for_review`)",
      params: by.params,
      body: z.object({ pr: pullRef }).openapi("GitHubMarkReadyBody"),
      response: GitHubDelivery.nullable(),
      errors: ["not_found", "forbidden", "validation_failed"],
      sdkMethod: { on: by.on, name: "markReady", options: ["pr"] },
      ...liveOf(by, NOT_YET),
      stability,
      handler: ({ session, params, body }) => {
        const pull = pullOf(session.id, body.pr);
        const who = actorOf(by, session.id, params);
        const actor = who.id;
        who.may(store.repo(pull.repo), PULLS);
        kit.allow(store.repo(pull.repo), actor, pull.author === actor ? "read" : "write");
        kit.action(store.repo(pull.repo), "markReady", { user: actor, number: pull.number });
        return caused(session.id, pulls.markReady(pull, actor));
      },
    });

    router.route({
      method: "post",
      path: `${by.prefix}/merge`,
      summary: "Merge a pull request. Sends `push` for the base branch, then `pull_request` (action `closed`, merged)",
      params: by.params,
      body: z
        .object({ pr: pullRef, method: z.enum(["merge", "squash", "rebase"]).default("merge") })
        .openapi("GitHubMergeBody"),
      response: GitHubDelivery.nullable(),
      errors: ["not_found", "forbidden", "not_allowed"],
      sdkMethod: { on: by.on, name: "merge", options: ["pr", "method"] },
      ...liveOf(by, NOT_YET),
      stability,
      handler: async ({ session, params, body }) => {
        const pull = pullOf(session.id, body.pr);
        const who = actorOf(by, session.id, params);
        const actor = who.id;
        who.may(store.repo(pull.repo), CONTENTS);
        kit.allow(store.repo(pull.repo), actor, "write");
        kit.action(store.repo(pull.repo), "merge", { user: actor, number: pull.number, method: body.method });
        return caused(session.id, (await pulls.merge(pull, actor, { method: body.method })).delivery);
      },
    });
  }

  // --- What people do: checks -----------------------------------------------------------------------

  router.route({
    method: "post",
    path: "/users/{user}/rerun",
    summary: 'Click "Re-run" on a check run. Sends `check_run` (action `rerequested`)',
    params: UserParams,
    body: z.object({ checkRun: checkRunRef }).openapi("GitHubRerunBody"),
    response: GitHubDelivery.nullable(),
    errors: ["not_found", "forbidden"],
    sdkMethod: { on: "GitHubUser", name: "rerun", options: ["checkRun"] },
    live: RERUN,
    stability,
    handler: ({ session, params, body }) => {
      const run = checkRunOf(session.id, body.checkRun);
      const actor = person(session.id, params.user);
      kit.allow(store.repo(run.repo), actor, "write");
      return caused(session.id, checks.rerun(run, actor));
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/request-action",
    summary: "Click one of the buttons the App put on a check run. Sends `check_run` (action `requested_action`)",
    params: UserParams,
    body: z.object({ identifier: z.string().min(1), checkRun: checkRunRef }).openapi("GitHubRequestActionBody"),
    response: GitHubDelivery.nullable(),
    errors: ["not_found", "forbidden"],
    // The button is there once the App has put it there: a person would wait for it.
    sdkMethod: { on: "GitHubUser", name: "requestAction", args: ["identifier"], options: ["checkRun"] },
    live: IN_THE_UI,
    stability,
    handler: ({ session, params, body }) => {
      const run = checkRunOf(session.id, body.checkRun);
      const actor = person(session.id, params.user);
      kit.allow(store.repo(run.repo), actor, "write");
      return caused(session.id, checks.requestAction(run, actor, body.identifier));
    },
  });

  // --- Reading an issue ---------------------------------------------------------------------------

  const issueRead = <R extends z.ZodType>(
    path: string,
    name: string,
    summary: string,
    response: R,
    read: (issue: GitHubIssueRecord, session: string) => z.input<R>,
    extra: { on?: string; onceQuiet?: boolean; waits?: Parameters<DriverRouter["route"]>[0]["waits"] } = {},
  ) =>
    router.route({
      method: "get",
      path: `/repos/{repo}/issues/{number}${path}`,
      summary,
      params: IssueParams,
      response,
      errors: ["not_found"],
      sdkMethod: {
        on: extra.on ?? "GitHubIssue",
        name,
        bind: issueBinding,
        ...(extra.onceQuiet ? { onceQuiet: true } : {}),
      },
      ...(extra.waits ? { waits: extra.waits } : {}),
      stability,
      handler: async ({ session, params }) => {
        const ref = { repoId: params.repo, number: params.number };
        await world.refresh(session.id, issueOf(session.id, ref));
        return read(issueOf(session.id, ref), session.id) as never;
      },
    });

  issueRead("", "refresh", "Read the issue again", GitHubIssue, issueWire);
  issueRead("/title", "title", "The issue's title as it is now", z.string(), (issue) => issue.title);
  issueRead(
    "/state",
    "state",
    "Open or closed, once the agent is quiet",
    z.enum(["open", "closed"]),
    (issue) => issue.state,
    {
      onceQuiet: true,
    },
  );
  issueRead("/labels", "labels", "The names of the labels on it", z.array(z.string()), (issue) => [...issue.labels]);
  issueRead("/assignees", "assignees", "Who it is assigned to", z.array(GitHubAuthor), (issue) =>
    issue.assignees.map(authorWire),
  );
  issueRead(
    "/comments",
    "comments",
    "The comments of the conversation, oldest first",
    z.array(GitHubComment).openapi("GitHubComments"),
    (issue, session) =>
      store.commentsOn(store.repo(issue.repo), issue.number).map((comment) => commentWire(session, comment)),
    {
      waits: [
        { name: "waitForComment", mode: "next", from: "author", text: "body", what: "a comment" },
        { name: "latestComment", mode: "latest", from: "author", what: "a comment" },
      ],
    },
  );
  issueRead(
    "/transcript",
    "transcript",
    "The issue or pull request as a person reads it: description, comments, reviews and threads",
    GitHubTranscript,
    (issue) => {
      const repo = store.repo(issue.repo);
      return renderTranscript(
        {
          issue,
          comments: store.commentsOn(repo, issue.number),
          reviews: store.reviewsOf(repo, issue.number),
          reviewComments: store.postedReviewComments(repo, issue.number),
        },
        principal,
      );
    },
  );

  // --- Reading a pull request ---------------------------------------------------------------------

  const pullRead = <R extends z.ZodType>(
    path: string,
    name: string,
    summary: string,
    response: R,
    read: (pull: ReturnType<typeof pullOf>, session: string) => z.input<R> | Promise<z.input<R>>,
    onceQuiet = false,
  ) =>
    router.route({
      method: "get",
      path: `/repos/{repo}/pulls/{number}${path}`,
      summary,
      params: IssueParams,
      response,
      errors: ["not_found"],
      sdkMethod: { on: "GitHubPullRequest", name, bind: issueBinding, ...(onceQuiet ? { onceQuiet: true } : {}) },
      live: NOT_YET,
      stability,
      handler: ({ session, params }) =>
        read(pullOf(session.id, { repoId: params.repo, number: params.number }), session.id) as never,
    });

  pullRead("", "refresh", "Read the pull request again", GitHubPullRequest, pullWire);
  pullRead(
    "/head-commit",
    "headCommit",
    "The newest commit of the pull request's branch, once the agent is quiet",
    GitHubCommit,
    async (pull) => {
      const repo = store.repo(pull.repo);
      await repos.refreshPull(repo, pull);
      const info = await git.readCommit(kit.dir(repo), pull.pull.headSha);
      if (!info) throw new ProtocolError("not_found", "The pull request's head commit is gone");
      return commitWire(repo, info, pull.pull.head);
    },
    true,
  );
  pullRead(
    "/reviews",
    "reviews",
    "The submitted reviews, oldest first",
    z.array(GitHubReview).openapi("GitHubReviews"),
    (pull, session) =>
      store
        .reviewsOf(store.repo(pull.repo), pull.number)
        .filter((review) => review.state !== "PENDING")
        .map((review) => reviewWire(session, review)),
  );
  pullRead(
    "/review-comments",
    "reviewComments",
    "The comments on the diff, oldest first",
    z.array(GitHubReviewComment).openapi("GitHubReviewComments"),
    (pull, session) =>
      store
        .postedReviewComments(store.repo(pull.repo), pull.number)
        .map((comment) => reviewCommentWire(session, comment)),
  );
  pullRead(
    "/check-runs",
    "checkRuns",
    "The check runs on the pull request's newest commit: the newest of each name",
    z.array(GitHubCheckRun).openapi("GitHubPullCheckRuns"),
    async (pull) => {
      const repo = store.repo(pull.repo);
      await repos.refreshPull(repo, pull);
      return checks.latest(repo, pull.pull.headSha).map(checkRunWire);
    },
  );
  pullRead("/merged", "merged", "Has the pull request been merged?", z.boolean(), (pull) => pull.pull.merged);

  // --- Reading comments ---------------------------------------------------------------------------

  const CommentParams = z.object({ comment: numberParam("comment") });

  router.route({
    method: "get",
    path: "/comments/{comment}",
    summary: "Read a conversation comment again",
    params: CommentParams,
    response: GitHubComment,
    errors: ["not_found"],
    sdkMethod: { on: "GitHubComment", name: "refresh" },
    stability,
    handler: async ({ session, params }) => {
      const { repo, issue } = store.comments.get(session.id, String(params.comment));
      await world.refresh(session.id, issueIn(store.repo(repo), issue));
      return commentWire(session.id, store.comments.get(session.id, String(params.comment)));
    },
  });

  router.route({
    method: "get",
    path: "/comments/{comment}/reactions",
    summary: "The reactions on a conversation comment, by content",
    params: CommentParams,
    response: z
      .array(z.object({ content: z.enum(REACTIONS), by: z.array(GitHubAuthor) }).openapi("GitHubReaction"))
      .openapi("GitHubReactions"),
    errors: ["not_found"],
    sdkMethod: { on: "GitHubComment", name: "reactions" },
    live: NOT_YET,
    stability,
    handler: ({ session, params }) => {
      const { reactions } = store.comments.get(session.id, String(params.comment));
      return REACTIONS.filter((content) => reactions.some((reaction) => reaction.content === content)).map(
        (content) => ({
          content,
          by: reactions.filter((reaction) => reaction.content === content).map((reaction) => authorWire(reaction.user)),
        }),
      );
    },
  });

  router.route({
    method: "get",
    path: "/comments/{comment}/delivery-for",
    summary:
      "The `issue_comment` (`created`) delivery this comment caused to this App (decision 0027), or nothing when it wasn't told. The comment's `delivery` is the built-in App's",
    params: CommentParams,
    query: z.object({ app: z.string().openapi({ param: { name: "app", in: "query" }, ...refTo("GitHubApp") }) }),
    response: GitHubDelivery.nullable(),
    errors: ["not_found"],
    sdkMethod: { on: "GitHubComment", name: "deliveryFor", args: ["app"] },
    live: APPS_NOT_YET,
    stability,
    handler: ({ session, params, query }) => {
      const comment = store.comments.get(session.id, String(params.comment));
      const app = store.apps.get(session.id, query.app);
      const found = fake.deliveries(session.id).find(({ request }) => {
        const payload = request.meta?.payload as { action?: string; comment?: { id?: number } } | undefined;
        return (
          request.app === app.name &&
          request.type === "issue_comment" &&
          payload?.action === "created" &&
          payload.comment?.id === comment.id
        );
      });
      return found ? deliveryWire(found) : null;
    },
  });

  /** The thread a comment on the diff is in: its first comment, then the replies. */
  const threadOf = (session: string, id: number) => {
    const [head, ...replies] = pulls.threadOf(reviewCommentOf(session, id));
    if (!head) throw new ProtocolError("not_found", "That thread has no comments left");
    return { head, replies };
  };

  router.route({
    method: "get",
    path: "/review-comments/{comment}/replies",
    summary: "The replies in this comment's thread, once the agent is quiet",
    params: CommentParams,
    response: z.array(GitHubReviewComment).openapi("GitHubReviewCommentReplies"),
    errors: ["not_found"],
    sdkMethod: { on: "GitHubReviewComment", name: "replies", onceQuiet: true },
    live: NOT_YET,
    stability,
    handler: ({ session, params }) =>
      threadOf(session.id, params.comment).replies.map((comment) => reviewCommentWire(session.id, comment)),
  });

  router.route({
    method: "get",
    path: "/review-comments/{comment}/resolved",
    summary: "Is this comment's thread resolved?",
    params: CommentParams,
    response: z.boolean(),
    errors: ["not_found"],
    sdkMethod: { on: "GitHubReviewComment", name: "resolved" },
    live: NOT_YET,
    stability,
    handler: ({ session, params }) => pulls.isResolved(threadOf(session.id, params.comment).head),
  });

  router.route({
    method: "get",
    path: "/review-comments/{comment}/transcript",
    summary: "This comment's thread as a person reads it",
    params: CommentParams,
    response: GitHubTranscript,
    errors: ["not_found"],
    sdkMethod: { on: "GitHubReviewComment", name: "transcript" },
    live: NOT_YET,
    stability,
    handler: ({ session, params }) => {
      const { head, replies } = threadOf(session.id, params.comment);
      return renderTranscript({ comments: [], reviews: [], reviewComments: [head, ...replies] }, principal);
    },
  });

  // --- Deliveries and calls -------------------------------------------------------------------------

  registerInspectionRoutes(router, {
    title: "GitHub",
    events: deps.events,
    stability,
    // Live, these read the App's delivery log on GitHub, and redeliver from it.
    deliveries: { ...world, resend: fake.resend },
    delivery: { schema: GitHubDelivery, wire: deliveryWire },
    apps: { handle: "GitHubApp", roster: store.apps },
    listSummary: "Every webhook channelstack sent the agent for this session, with every attempt",
    filters: {
      type: "Only this event, e.g. `issue_comment`.",
      resource: {
        description: "Only deliveries about this repository.",
        ref: "GitHubRepo",
        matches: ({ request }, repo) => String(request.meta?.repo) === repo,
      },
    },
    live: { reads: undefined },
    redeliver: {
      summary: "Redeliver from the App's delivery log, as GitHub's UI and API do: the same GUID, a new attempt",
    },
    resend: {
      summary: "Send the delivery again, unchanged or signed with a secret that isn't the App's",
      options: ["badSignature"],
    },
    calls: {
      schema: GitHubApiCall,
      summary:
        "The REST calls the agent made about this session's repositories. Calls about no repository (`GET /app`) are in no session",
      live: AGENT_SIDE,
    },
  });

  router.route({
    method: "get",
    path: "/app-calls",
    summary:
      "The App's REST calls that are about no repository of any session: its own endpoints and the token exchange. They belong to no session, so every session reads the same list. Only calls that authenticated as the App or its installation are on it",
    query: CallsQuery,
    response: z.array(GitHubApiCall).openapi("GitHubAppCalls"),
    sdkMethod: { on: "GitHubFixture", name: "appCalls", options: ["operation", "error"] },
    live: AGENT_SIDE,
    stability,
    handler: ({ query }) => readCalls(deps.events, WORLD_SCOPE, "github", query),
  });
}
