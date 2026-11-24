import type { Clock } from "../../../core/clock/index.ts";
import type { DeliveryAttempt } from "../../../core/delivery/index.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { IdGenerator } from "../../../core/ids/index.ts";
import { LivePeople } from "../../../core/people/index.ts";
import { fakeActorInLiveWorld, liveMisconfigured, unsupportedInLive } from "../../../core/reality/index.ts";
import { Registry } from "../../../core/registry/index.ts";
import type { LiveContext } from "../../../core/router/index.ts";
import { taggedNames } from "../../../core/safety/index.ts";
import type { GitHubDeliveryView, GitHubWorld } from "../backend.ts";
import { GitHubRefusal } from "../fake/kit.ts";
import { GitHubStore } from "../fake/store.ts";
import type {
  GitHubCommentRecord,
  GitHubIssueRecord,
  GitHubPermission,
  GitHubRepoRecord,
  GitHubUserRecord,
} from "../world.ts";
import { type GitHubCaller, type GitHubLiveClient, passing } from "./client.ts";
import { checkGitHubPerson, identifyApp, identifyPerson, testOrg } from "./identity.ts";

/** Real GitHub's web app: where its links point. */
const GITHUB_WEB = "https://github.com";
/** How long an issue read from GitHub is used again before it is read anew. */
const READ_CACHE_MS = 1_000;
/** GitHub's names for a collaborator's permission (`read` is `pull`, `write` is `push`). */
const PERMISSION: Readonly<Record<GitHubPermission, string>> = {
  read: "pull",
  triage: "triage",
  write: "push",
  maintain: "maintain",
  admin: "admin",
};

interface WireUser {
  id: number;
  login: string;
  type: string;
}
interface WireRepo {
  id: number;
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  created_at: string;
  pushed_at: string | null;
  updated_at: string;
}
interface WireIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  user: WireUser;
  state: "open" | "closed";
  state_reason: GitHubIssueRecord["stateReason"];
  labels: Array<{ name: string } | string>;
  assignees: WireUser[] | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by?: WireUser | null;
}
interface WireComment {
  id: number;
  body: string;
  user: WireUser;
  created_at: string;
  updated_at: string;
}
interface WireHookDelivery {
  id: number;
  guid: string;
  delivered_at: string;
  duration: number;
  status: string;
  status_code: number;
  event: string;
  action: string | null;
  repository_id: number | null;
}

export interface LiveGitHubWorld extends GitHubWorld {
  ready(): Promise<void>;
  release(session: string): void;
  /** The App's installation on the test org: who makes and removes the session's repositories. */
  installation(): GitHubCaller;
}

/**
 * The live GitHub world (live-mode.md, A1 and A2): the App's installation on the test org makes
 * each session's repositories (tagged, in the ledger, deleted when the session closes), people act
 * with their own tokens, and the App's delivery log shows what GitHub sent the agent. What it reads
 * and makes is kept in a store of its own with the fake's record shapes, so the routes read from
 * it as from the fake's.
 */
export function createLiveGitHubWorld(deps: {
  client: GitHubLiveClient;
  live: LiveContext;
  ids: IdGenerator;
  clock: Clock;
}): LiveGitHubWorld {
  const { client, live, ids, clock } = deps;
  const registry = new Registry();
  const store = new GitHubStore(registry);
  /** The real people the open sessions hold: one record each, whichever sessions have them. */
  const people = new LivePeople();
  const readAt = new Map<number, number>();
  const payloads = new Map<number, unknown>();
  let checked: Promise<void> | undefined;
  let selection: "all" | "selected" = "selected";
  /** Where GitHub sends the App's webhooks: the agent's own URL. */
  let hookUrl = "";
  const repoName = taggedNames(live.tag);

  const asApp: GitHubCaller = { app: true };
  const installation = (): GitHubCaller => ({ installation: store.app.installationId });
  /** The person acting, who must be real: a fake person can't act in a live org (core's rule). */
  const actor = (session: string, userId: number): GitHubCaller => ({
    token: people.actingAs(session, String(userId), () =>
      fakeActorInLiveWorld(store.users.find(String(userId))?.login ?? String(userId), "github"),
    ),
  });
  const path = (repo: GitHubRepoRecord) => ({ owner: repo.owner, repo: repo.name });
  const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : undefined);
  const loginOf = (id: number) => store.actor(id).login;

  // --- Mirroring what GitHub answers ------------------------------------------------------------

  /** Someone a record names: a person of a session, the App's bot, or someone else on GitHub. */
  const userOf = (wire: WireUser): number => {
    if (wire.login === store.bot.login) return store.bot.id;
    if (!store.users.find(String(wire.id))) {
      store.users.add(String(wire.id), {
        id: wire.id,
        login: wire.login,
        name: undefined,
        email: undefined,
        type: wire.type === "Bot" ? "Bot" : "User",
        role: "member",
        fixedId: false,
        createdAt: clock(),
      } satisfies GitHubUserRecord);
    }
    return wire.id;
  };

  /** Keep a record for its session, or change the one kept: a route may hold it across a read. */
  const upsert = <T extends { id: number }>(
    collection: typeof store.issues | typeof store.comments,
    session: string,
    record: T,
  ): T => {
    const known = collection.find(String(record.id)) as T | undefined;
    if (known) return Object.assign(known, record);
    return store.add(collection as never, session, record as never) as T;
  };

  const toIssue = (repo: GitHubRepoRecord, wire: WireIssue): GitHubIssueRecord => {
    const known = store.issues.find(String(wire.id));
    return upsert(store.issues, store.sessionOf(repo), {
      id: wire.id,
      repo: repo.id,
      number: wire.number,
      title: wire.title,
      body: wire.body,
      author: userOf(wire.user),
      state: wire.state,
      stateReason: wire.state_reason ?? null,
      labels: wire.labels.map((label) => (typeof label === "string" ? label : label.name)),
      assignees: (wire.assignees ?? []).map(userOf),
      reactions: known?.reactions ?? [],
      createdAt: Date.parse(wire.created_at),
      updatedAt: Date.parse(wire.updated_at),
      closedAt: time(wire.closed_at),
      closedBy: wire.closed_by ? userOf(wire.closed_by) : undefined,
      pull: undefined,
    } satisfies GitHubIssueRecord);
  };

  const toComment = (repo: GitHubRepoRecord, issue: number, wire: WireComment): GitHubCommentRecord => {
    const known = store.comments.find(String(wire.id));
    return upsert(store.comments, store.sessionOf(repo), {
      id: wire.id,
      repo: repo.id,
      issue,
      author: userOf(wire.user),
      body: wire.body,
      reactions: known?.reactions ?? [],
      minimized: undefined,
      createdAt: Date.parse(wire.created_at),
      updatedAt: Date.parse(wire.updated_at),
      // Only the fake delivers: live, GitHub delivers to the agent itself.
      delivery: undefined,
    } satisfies GitHubCommentRecord);
  };

  const readIssue = async (issue: GitHubIssueRecord, force = false) => {
    const last = readAt.get(issue.id);
    if (!force && last !== undefined && clock() - last < READ_CACHE_MS) return;
    const repo = store.repo(issue.repo);
    const session = store.sessionOf(repo);
    toIssue(
      repo,
      await client.call<WireIssue>(installation(), "GET /repos/{owner}/{repo}/issues/{issue_number}", {
        ...path(repo),
        issue_number: issue.number,
      }),
    );
    const comments = await client.all<WireComment>(
      installation(),
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      { ...path(repo), issue_number: issue.number },
    );
    const now = new Set(comments.map((comment) => comment.id));
    for (const gone of store.commentsOn(repo, issue.number).filter((comment) => !now.has(comment.id)))
      store.forget(store.comments, session, gone.id);
    for (const wire of comments) toComment(repo, issue.number, wire);
    readAt.set(issue.id, clock());
  };

  // --- The App's delivery log -------------------------------------------------------------------

  const statusOf = (wire: WireHookDelivery): DeliveryAttempt["status"] => {
    if (wire.status_code >= 200 && wire.status_code < 300) return "acknowledged";
    if (wire.status_code === 0) return /time/i.test(wire.status) ? "timed_out" : "unreachable";
    return "failed";
  };

  /** The deliveries about a session's repositories, each with its attempts (a redelivery is one more). */
  const deliveriesOf = async (session: string): Promise<GitHubDeliveryView[]> => {
    const repos = store.list(store.repos, session);
    if (repos.length === 0) return [];
    const ours = new Set(repos.map((repo) => repo.id));
    const since = Math.min(...repos.map((repo) => repo.createdAt));
    const log = await client.all<WireHookDelivery>(asApp, "GET /app/hook/deliveries");
    const byGuid = new Map<string, WireHookDelivery[]>();
    for (const wire of log) {
      if (wire.repository_id === null || !ours.has(wire.repository_id) || Date.parse(wire.delivered_at) < since)
        continue;
      byGuid.set(wire.guid, [...(byGuid.get(wire.guid) ?? []), wire]);
    }
    const views: GitHubDeliveryView[] = [];
    for (const [guid, tries] of byGuid) {
      tries.sort((a, b) => Date.parse(a.delivered_at) - Date.parse(b.delivered_at));
      const first = tries[0] as WireHookDelivery;
      if (!payloads.has(first.id)) {
        const detail = await client.call<{ request?: { payload?: unknown } }>(
          asApp,
          "GET /app/hook/deliveries/{delivery_id}",
          { delivery_id: first.id },
        );
        payloads.set(first.id, detail.request?.payload);
      }
      views.push({
        request: {
          id: guid,
          type: first.event,
          meta: { action: first.action, payload: payloads.get(first.id), repo: first.repository_id },
        },
        attempts: tries.map((wire, at) => ({
          number: at + 1,
          sentAt: new Date(wire.delivered_at).toISOString(),
          transport: "http",
          url: hookUrl,
          requestHeaders: {},
          status: statusOf(wire),
          ...(wire.status_code > 0 ? { responseStatus: wire.status_code } : {}),
          durationMs: Math.round(wire.duration * 1000),
          forgedSignature: false,
        })),
      });
    }
    return views.sort((a, b) => (a.attempts[0]?.sentAt ?? "").localeCompare(b.attempts[0]?.sentAt ?? ""));
  };

  const deliveryOf = async (session: string, guid: string) => {
    const found = (await deliveriesOf(session)).find((view) => view.request.id === guid);
    if (!found) throw new ProtocolError("not_found", `No delivery ${guid} about this session's repositories`);
    return found;
  };

  return {
    store,
    repoWeb: (repo) => `${GITHUB_WEB}/${repo.owner}/${repo.name}`,
    installation,

    async ready() {
      checked ??= (async () => {
        const identity = await identifyApp(client);
        const install = testOrg(identity, live.allowlist);
        const { app } = identity;
        selection = install.selection;
        // An App without a webhook URL has none to show: its deliveries have no URL either.
        const hook = await client.call<{ url?: string }>(asApp, "GET /app/hook/config").catch(() => undefined);
        hookUrl = hook?.url ?? "";
        const bot = await client.call<WireUser>({ installation: install.id }, "GET /users/{username}", {
          username: `${app.slug}[bot]`,
        });
        store.seed(
          { id: install.account.id, login: install.account.login },
          {
            id: app.id,
            slug: app.slug,
            name: app.name,
            clientId: app.clientId,
            botId: bot.id,
            installationId: install.id,
            events: app.events,
            permissions: install.permissions,
            createdAt: app.createdAt,
          },
        );
      })().catch((error: unknown) => {
        // A definitive answer is kept; a network error, a rate limit or GitHub's own failure isn't: the next action asks again.
        if (!(error instanceof ProtocolError) || passing(error)) checked = undefined;
        throw error;
      });
      return checked;
    },

    release(session) {
      for (const issue of store.list(store.issues, session)) readAt.delete(issue.id);
      // A person another open session holds stays theirs.
      const gone = people.leave(session);
      store.release(session);
      registry.release(session);
      for (const id of gone) store.users.remove(id);
    },

    async createUser(session, input) {
      for (const option of ["id", "name", "email", "role"] as const) {
        if (input[option] !== undefined) {
          throw unsupportedInLive(
            `GitHubFixture.createUser({ ${option} })`,
            `a live person's ${option === "role" ? "org role" : option} is their account's`,
          );
        }
      }
      if (store.byLogin(session, input.login))
        throw new ProtocolError("invalid_argument", `There is already a person "${input.login}" in this session`);
      if (input.token === undefined) {
        if (live.strict) {
          throw liveMisconfigured(
            `CHANNELSTACK_REALITY is live and ${input.login} has no token`,
            "set CHANNELSTACK_GITHUB_USER_<LOGIN>_TOKEN for them, or run without CHANNELSTACK_REALITY=live",
          );
        }
        // A fake person can exist next to a live org, but can't act in it.
        const id = Number(ids.next("github.user"));
        return store.add(store.users, session, {
          id,
          login: input.login,
          name: undefined,
          email: undefined,
          type: "User",
          role: "member",
          fixedId: false,
          createdAt: clock(),
        } satisfies GitHubUserRecord);
      }
      const key = live.vault.person(input.login, input.token);
      const who = await identifyPerson(client, key);
      checkGitHubPerson(who, { who: `${input.login}'s token`, login: input.login });
      people.join(session, String(who.id), input.login, key);
      // One record, no session's: parallel tests have the same person.
      return store.share(store.users, session, {
        id: who.id,
        login: who.login,
        name: undefined,
        // A real person's email never leaves the server: the live world keeps none.
        email: undefined,
        type: "User",
        role: "member",
        fixedId: false,
        createdAt: clock(),
      } satisfies GitHubUserRecord);
    },

    async createRepo(session, input) {
      const org = store.org.login;
      const installed = input.installed === true;
      if (installed && selection !== "all") {
        throw liveMisconfigured(
          `the App's installation on ${org} covers selected repositories`,
          "set it to All repositories in the org's settings (GitHub Apps → Configure), so the App hears about each test repository",
        );
      }
      if (!installed && selection === "all") {
        throw unsupportedInLive(
          "GitHubFixture.createRepo without apps",
          `the App's installation covers all of ${org}'s repositories, so it hears about every one`,
        );
      }
      const name = repoName(input.name);
      let created: WireRepo;
      try {
        created = await client.call<WireRepo>(installation(), "POST /orgs/{org}/repos", {
          org,
          name,
          private: input.private ?? false,
          auto_init: true,
          description: "A channelstack test repository: it goes away when its test session closes",
        });
      } catch (error) {
        if (error instanceof GitHubRefusal && error.githubStatus === 403) {
          throw liveMisconfigured(
            `the App can't create repositories in ${org}`,
            "give it the Administration (read and write) permission, and accept it in the org",
          );
        }
        throw error;
      }
      live.ledger.record({
        channel: "github",
        kind: "repo",
        // What GitHub made, which may differ from what was asked for (it rewrites some characters).
        ref: { repo: `${created.owner.login}/${created.name}`, name: created.name },
        workspace: org,
        by: "app",
        session,
      });
      const repo = store.add(store.repos, session, {
        id: created.id,
        owner: created.owner.login,
        name: created.name,
        private: created.private,
        defaultBranch: created.default_branch,
        collaborators: new Map(),
        installed,
        labels: new Map(),
        createdAt: Date.parse(created.created_at),
        pushedAt: time(created.pushed_at) ?? Date.parse(created.created_at),
        updatedAt: Date.parse(created.updated_at),
      } satisfies GitHubRepoRecord);
      if (input.defaultBranch !== undefined && input.defaultBranch !== created.default_branch) {
        await client.call(installation(), "POST /repos/{owner}/{repo}/branches/{branch}/rename", {
          ...path(repo),
          branch: created.default_branch,
          new_name: input.defaultBranch,
        });
        repo.defaultBranch = input.defaultBranch;
      }
      for (const file of input.files ?? []) {
        const at = file.path.replace(/^\.?\//, "");
        let sha: string | undefined;
        try {
          sha = (
            await client.call<{ sha: string }>(installation(), "GET /repos/{owner}/{repo}/contents/{path}", {
              ...path(repo),
              path: at,
            })
          ).sha;
        } catch (error) {
          if (!(error instanceof GitHubRefusal && error.githubStatus === 404)) throw error;
        }
        await client.call(installation(), "PUT /repos/{owner}/{repo}/contents/{path}", {
          ...path(repo),
          path: at,
          message: `Add ${at}`,
          content: Buffer.from(file.content).toString("base64"),
          ...(sha ? { sha } : {}),
        });
      }
      for (const label of input.labels ?? []) {
        const made = await client.call<{ id: number; name: string; color: string; description: string | null }>(
          installation(),
          "POST /repos/{owner}/{repo}/labels",
          { ...path(repo), name: label.name, color: label.color ?? "ededed", description: label.description },
        );
        repo.labels.set(made.name.toLowerCase(), made);
      }
      for (const { user, permission } of input.collaborators ?? []) {
        const login = store.actor(user).login;
        // Only this session's own people: one it doesn't hold isn't added, nor acts.
        const as = actor(session, user);
        const added = await client.request(installation(), "PUT /repos/{owner}/{repo}/collaborators/{username}", {
          ...path(repo),
          username: login,
          permission: PERMISSION[permission],
        });
        // An org member is added at once; anyone else is invited, and accepts as themselves.
        if (added.status === 201) {
          const invitations = await client.all<{ id: number; repository: { id: number } }>(
            as,
            "GET /user/repository_invitations",
          );
          const invitation = invitations.find((candidate) => candidate.repository.id === repo.id);
          if (invitation) {
            await client.call(as, "PATCH /user/repository_invitations/{invitation_id}", {
              invitation_id: invitation.id,
            });
          }
        }
        repo.collaborators.set(login, permission);
      }
      return repo;
    },

    async readFile(repo, file, ref) {
      try {
        const raw = await client.call<string | ArrayBuffer>(
          installation(),
          "GET /repos/{owner}/{repo}/contents/{path}",
          {
            ...path(repo),
            path: file.replace(/^\//, ""),
            ...(ref ? { ref } : {}),
            headers: { accept: "application/vnd.github.raw+json" },
          },
        );
        // The raw media type: Octokit hands over text, or bytes when GitHub doesn't call it text.
        return typeof raw === "string" ? Buffer.from(raw) : new Uint8Array(raw);
      } catch (error) {
        if (error instanceof GitHubRefusal && error.githubStatus === 404) return undefined;
        throw error;
      }
    },

    async openIssue(repo, userId, input) {
      const wire = await client.call<WireIssue>(
        actor(store.sessionOf(repo), userId),
        "POST /repos/{owner}/{repo}/issues",
        {
          ...path(repo),
          title: input.title,
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.labels?.length ? { labels: input.labels } : {}),
          ...(input.assignees?.length ? { assignees: input.assignees.map(loginOf) } : {}),
        },
      );
      return toIssue(repo, wire);
    },

    async updateIssue(issue, userId, changes) {
      const repo = store.repo(issue.repo);
      const wire = await client.call<WireIssue>(
        actor(store.sessionOf(repo), userId),
        "PATCH /repos/{owner}/{repo}/issues/{issue_number}",
        {
          ...path(repo),
          issue_number: issue.number,
          ...(changes.title !== undefined ? { title: changes.title } : {}),
          ...(changes.body !== undefined ? { body: changes.body } : {}),
          ...(changes.state !== undefined ? { state: changes.state } : {}),
          ...(changes.stateReason !== undefined ? { state_reason: changes.stateReason } : {}),
        },
      );
      toIssue(repo, wire);
      return undefined;
    },

    async label(issue, userId, labels, add) {
      const repo = store.repo(issue.repo);
      const by = actor(store.sessionOf(repo), userId);
      if (add) {
        await client.call(by, "POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
          ...path(repo),
          issue_number: issue.number,
          labels: [...labels],
        });
      } else {
        for (const name of labels) {
          await client.call(by, "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", {
            ...path(repo),
            issue_number: issue.number,
            name,
          });
        }
      }
      await readIssue(issue, true);
      return [];
    },

    async assign(issue, userId, assignees) {
      const repo = store.repo(issue.repo);
      const logins = assignees.map(loginOf);
      const wire = await client.call<WireIssue>(
        actor(store.sessionOf(repo), userId),
        "POST /repos/{owner}/{repo}/issues/{issue_number}/assignees",
        { ...path(repo), issue_number: issue.number, assignees: logins },
      );
      toIssue(repo, wire);
      return [];
    },

    async comment(issue, userId, body) {
      const repo = store.repo(issue.repo);
      const wire = await client.call<WireComment>(
        actor(store.sessionOf(repo), userId),
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { ...path(repo), issue_number: issue.number, body },
      );
      // What a person did changes the issue: the next read asks GitHub again.
      readAt.delete(issue.id);
      return toComment(repo, issue.number, wire);
    },

    async editComment(comment, userId, body) {
      const repo = store.repo(comment.repo);
      const wire = await client.call<WireComment>(
        actor(store.sessionOf(repo), userId),
        "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
        { ...path(repo), comment_id: comment.id, body },
      );
      toComment(repo, comment.issue, wire);
      return undefined;
    },

    async deleteComment(comment, userId) {
      const repo = store.repo(comment.repo);
      await client.call(
        actor(store.sessionOf(repo), userId),
        "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}",
        {
          ...path(repo),
          comment_id: comment.id,
        },
      );
      store.forget(store.comments, store.sessionOf(repo), comment.id);
      return undefined;
    },

    async react(target, userId, content) {
      const repo = store.repo(target.repo);
      const made = await client.call<{ id: number; created_at: string }>(
        actor(store.sessionOf(repo), userId),
        "issue" in target
          ? "POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions"
          : "POST /repos/{owner}/{repo}/issues/{issue_number}/reactions",
        {
          ...path(repo),
          ...("issue" in target ? { comment_id: target.id } : { issue_number: target.number }),
          content,
        },
      );
      target.reactions.push({ id: made.id, user: userId, content, createdAt: Date.parse(made.created_at) });
    },

    refresh: (_session, issue) => readIssue(issue),

    deliveries: (session) => deliveriesOf(session),
    delivery: (session, guid) => deliveryOf(session, guid),
    async redeliver(session, guid) {
      const found = await deliveryOf(session, guid);
      const log = await client.all<WireHookDelivery>(asApp, "GET /app/hook/deliveries");
      const latest = log
        .filter((wire) => wire.guid === guid)
        .sort((a, b) => Date.parse(b.delivered_at) - Date.parse(a.delivered_at))[0];
      if (!latest) throw new ProtocolError("not_found", `No delivery ${guid} in the App's delivery log`);
      await client.call(asApp, "POST /app/hook/deliveries/{delivery_id}/attempts", { delivery_id: latest.id });
      return {
        number: found.attempts.length + 1,
        sentAt: new Date(clock()).toISOString(),
        transport: "http",
        url: hookUrl,
        requestHeaders: {},
        // GitHub sends it again on its own time; the delivery log shows how it went.
        status: "pending",
        forgedSignature: false,
      };
    },
  };
}
