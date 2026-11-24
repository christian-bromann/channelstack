import { generateKeyPairSync } from "node:crypto";

import { randomString } from "../src/core/secrets/index.ts";

/**
 * A stand-in for real GitHub's REST API in unit tests of live mode: an org in memory with the
 * agent's App installed, answering the calls the live backend makes in GitHub's shapes, and
 * recording each with who made it (`app` for the App's JWT, `installation`, or a person's login).
 * The App's JWT is signed with a real key (`privateKey`), which the stub doesn't check. People are
 * invited to a repository and accept as themselves. `agentComments` plays the agent: its comment,
 * and the delivery that reached it in the App's delivery log.
 */
export interface GitHubStub {
  readonly url: string;
  fetch: typeof fetch;
  readonly org: string;
  readonly app: { id: number; slug: string; botId: number; installationId: number };
  readonly privateKey: string;
  person(login: string, options?: { type?: "User" | "Bot" }): { token: string; id: number };
  readonly calls: Array<{ method: string; path: string; as: string }>;
  /** The installation covers selected repositories instead of all. */
  selectOnly(): void;
  /** The App's installation is on a user account instead. */
  onUserAccount(): void;
  agentComments(repo: string, issue: number, body: string, delivery?: { status?: number }): void;
  repo(name: string): { name: string; deleted: boolean; collaborators: string[]; labels: string[] } | undefined;
}

const hex = "0123456789abcdef";

interface Repo {
  id: number;
  name: string;
  deleted: boolean;
  defaultBranch: string;
  collaborators: Map<string, string>;
  labels: Map<string, { id: number; name: string; color: string; description: string | null }>;
  files: Map<string, { content: string; sha: string }>;
  issues: Issue[];
  createdAt: string;
}
interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  user: string;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
  comments: Array<{ id: number; body: string; user: string; at: string }>;
  reactions: Array<{ id: number; content: string; user: string }>;
}

export function githubStub(options: { org?: string } = {}): GitHubStub {
  const org = options.org ?? "acme-tests";
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let next = 1_000;
  const id = () => ++next;
  const app = { id: 1, slug: "my-agent", botId: id(), installationId: id() };
  const installationToken = `ghs_${randomString(36, hex)}`;
  const people = new Map<string, { id: number; login: string; type: string }>([
    [`${app.slug}[bot]`, { id: app.botId, login: `${app.slug}[bot]`, type: "Bot" }],
  ]);
  const tokens = new Map<string, string>();
  const repos = new Map<string, Repo>();
  const invitations: Array<{ id: number; repo: string; login: string }> = [];
  const deliveries: Array<{
    id: number;
    guid: string;
    delivered_at: string;
    duration: number;
    status: string;
    status_code: number;
    event: string;
    action: string | null;
    repository_id: number;
    payload: unknown;
  }> = [];
  const calls: GitHubStub["calls"] = [];
  let selection: "all" | "selected" = "all";
  let accountType = "Organization";
  const now = () => new Date().toISOString();

  const json = (status: number, body?: unknown) =>
    body === undefined ? new Response(null, { status }) : Response.json(body, { status });
  const refuse = (status: number, message: string) => json(status, { message, documentation_url: "" });
  const userOut = (login: string) => {
    const user = people.get(login);
    return { id: user?.id ?? 0, login, type: user?.type ?? "User" };
  };
  const repoOut = (repo: Repo) => ({
    id: repo.id,
    name: repo.name,
    full_name: `${org}/${repo.name}`,
    owner: { login: org },
    private: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    pushed_at: repo.createdAt,
    updated_at: repo.createdAt,
  });
  const issueOut = (issue: Issue) => ({
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userOut(issue.user),
    state: issue.state,
    state_reason: issue.state === "closed" ? "completed" : null,
    labels: issue.labels.map((name) => ({ name })),
    assignees: issue.assignees.map(userOut),
    created_at: now(),
    updated_at: now(),
    closed_at: issue.state === "closed" ? now() : null,
  });
  const commentOut = (comment: Issue["comments"][number]) => ({
    id: comment.id,
    body: comment.body,
    user: userOut(comment.user),
    created_at: comment.at,
    updated_at: comment.at,
  });

  const handle = (
    as: string,
    method: string,
    path: string,
    body: Record<string, unknown>,
    accept: string,
  ): Response => {
    const route = `${method} ${path}`;
    const byApp = as === "app";
    const byInstallation = as === "installation";
    let match: RegExpExecArray | null;
    if (route === "GET /app" && byApp)
      return json(200, {
        id: app.id,
        slug: app.slug,
        name: "My Agent",
        client_id: "Iv1.stub",
        events: ["issues", "issue_comment"],
        created_at: now(),
      });
    if (route === "GET /app/installations" && byApp)
      return json(200, [
        {
          id: app.installationId,
          account: { id: 42, login: org, type: accountType },
          repository_selection: selection,
          permissions: { issues: "write", administration: "write", contents: "write" },
        },
      ]);
    if (route === `POST /app/installations/${app.installationId}/access_tokens` && byApp)
      return json(201, {
        token: installationToken,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: {},
        repository_selection: selection,
      });
    if (route === "GET /app/hook/config" && byApp)
      return json(200, { url: "https://agent.example/webhooks", content_type: "json" });
    if (route === "GET /app/hook/deliveries" && byApp)
      return json(
        200,
        [...deliveries].reverse().map(({ payload: _payload, ...entry }) => entry),
      );
    match = /^GET \/app\/hook\/deliveries\/(\d+)$/.exec(route);
    if (match && byApp) {
      const found = deliveries.find((entry) => entry.id === Number(match?.[1]));
      return found
        ? json(200, { ...found, request: { headers: {}, payload: found.payload } })
        : refuse(404, "Not Found");
    }
    match = /^POST \/app\/hook\/deliveries\/(\d+)\/attempts$/.exec(route);
    if (match && byApp) {
      const found = deliveries.find((entry) => entry.id === Number(match?.[1]));
      if (!found) return refuse(404, "Not Found");
      deliveries.push({ ...found, id: id(), delivered_at: now() });
      return json(202, {});
    }
    match = /^GET \/users\/(.+)$/.exec(route);
    if (match) {
      const user = people.get(decodeURIComponent(match[1] as string));
      return user ? json(200, user) : refuse(404, "Not Found");
    }
    if (route === "GET /user") {
      const user = people.get(as);
      return user ? json(200, user) : refuse(401, "Bad credentials");
    }
    if (route === "GET /user/repository_invitations")
      return json(
        200,
        invitations
          .filter((invite) => invite.login === as)
          .map((invite) => ({ id: invite.id, repository: { id: repos.get(invite.repo)?.id } })),
      );
    match = /^PATCH \/user\/repository_invitations\/(\d+)$/.exec(route);
    if (match) {
      const at = invitations.findIndex((invite) => invite.id === Number(match?.[1]) && invite.login === as);
      if (at === -1) return refuse(404, "Not Found");
      const [invite] = invitations.splice(at, 1);
      repos.get(invite?.repo as string)?.collaborators.set(as, "accepted");
      return json(204);
    }
    if (route === `POST /orgs/${org}/repos`) {
      if (!byInstallation) return refuse(403, "Resource not accessible by personal access token");
      const name = String(body.name);
      if (repos.has(name)) return refuse(422, "Repository creation failed: name already exists on this account");
      const repo: Repo = {
        id: id(),
        name,
        deleted: false,
        defaultBranch: "main",
        collaborators: new Map(),
        labels: new Map(),
        files: new Map(body.auto_init ? [["README.md", { content: `# ${name}\n`, sha: randomString(40, hex) }]] : []),
        issues: [],
        createdAt: now(),
      };
      repos.set(name, repo);
      return json(201, repoOut(repo));
    }
    if (route === `GET /orgs/${org}/repos`)
      return json(200, [...repos.values()].filter((repo) => !repo.deleted).map(repoOut));
    match = new RegExp(`^(\\w+) /repos/${org}/([^/]+)(/.*)?$`).exec(route);
    if (!match) return refuse(404, "Not Found");
    const repo = repos.get(match[2] as string);
    if (!repo || repo.deleted) return refuse(404, "Not Found");
    const rest = match[3] ?? "";
    const person = !byApp && !byInstallation;
    if (person && !repo.collaborators.has(as)) return refuse(404, "Not Found");
    if (method === "DELETE" && rest === "") {
      if (!byInstallation) return refuse(403, "Must have admin rights to Repository.");
      repo.deleted = true;
      return json(204);
    }
    match = /^\/collaborators\/(.+)$/.exec(rest);
    if (match && method === "PUT") {
      const login = match[1] as string;
      invitations.push({ id: id(), repo: repo.name, login });
      return json(201, { id: invitations.at(-1)?.id });
    }
    if (rest === "/labels" && method === "POST") {
      const label = {
        id: id(),
        name: String(body.name),
        color: String(body.color),
        description: (body.description as string) ?? null,
      };
      repo.labels.set(label.name.toLowerCase(), label);
      return json(201, label);
    }
    match = /^\/branches\/([^/]+)\/rename$/.exec(rest);
    if (match && method === "POST") {
      repo.defaultBranch = String(body.new_name);
      return json(201, { name: repo.defaultBranch });
    }
    match = /^\/contents\/(.+)$/.exec(rest);
    if (match) {
      const at = decodeURIComponent(match[1] as string);
      if (method === "PUT") {
        repo.files.set(at, {
          content: Buffer.from(String(body.content), "base64").toString("utf8"),
          sha: randomString(40, hex),
        });
        return json(201, { content: { path: at } });
      }
      const file = repo.files.get(at);
      if (!file) return refuse(404, "Not Found");
      // The raw media type answers with the file's text itself, as GitHub does.
      if (accept.includes("raw"))
        return new Response(file.content, { headers: { "content-type": "application/vnd.github.raw" } });
      return json(200, { path: at, sha: file.sha, content: Buffer.from(file.content).toString("base64") });
    }
    if (rest === "/issues" && method === "POST") {
      const issue: Issue = {
        id: id(),
        number: repo.issues.length + 1,
        title: String(body.title),
        body: (body.body as string) ?? null,
        user: as,
        state: "open",
        labels: (body.labels as string[]) ?? [],
        assignees: (body.assignees as string[]) ?? [],
        comments: [],
        reactions: [],
      };
      repo.issues.push(issue);
      return json(201, issueOut(issue));
    }
    match = /^\/issues\/comments\/(\d+)(\/reactions)?$/.exec(rest);
    if (match) {
      const commentId = Number(match[1]);
      const issue = repo.issues.find((candidate) => candidate.comments.some((comment) => comment.id === commentId));
      const comment = issue?.comments.find((candidate) => candidate.id === commentId);
      if (!issue || !comment) return refuse(404, "Not Found");
      if (match[2]) return json(201, { id: id(), content: body.content, created_at: now() });
      if (comment.user !== as) return refuse(403, "Must have write access to edit someone else's comment");
      if (method === "PATCH") comment.body = String(body.body);
      if (method === "DELETE") {
        issue.comments.splice(issue.comments.indexOf(comment), 1);
        return json(204);
      }
      return json(200, commentOut(comment));
    }
    match = /^\/issues\/(\d+)(\/.*)?$/.exec(rest);
    if (match) {
      const issue = repo.issues.find((candidate) => candidate.number === Number(match?.[1]));
      if (!issue) return refuse(404, "Not Found");
      const sub = match[2] ?? "";
      if (sub === "" && method === "GET") return json(200, issueOut(issue));
      if (sub === "" && method === "PATCH") {
        if (typeof body.title === "string") issue.title = body.title;
        if (body.state === "open" || body.state === "closed") issue.state = body.state;
        return json(200, issueOut(issue));
      }
      if (sub === "/comments" && method === "GET") return json(200, issue.comments.map(commentOut));
      if (sub === "/comments" && method === "POST") {
        const comment = { id: id(), body: String(body.body), user: as, at: now() };
        issue.comments.push(comment);
        return json(201, commentOut(comment));
      }
      if (sub === "/labels" && method === "POST") {
        for (const name of body.labels as string[]) if (!issue.labels.includes(name)) issue.labels.push(name);
        return json(
          200,
          issue.labels.map((name) => ({ name })),
        );
      }
      match = /^\/labels\/(.+)$/.exec(sub);
      if (match && method === "DELETE") {
        issue.labels = issue.labels.filter((name) => name !== decodeURIComponent(match?.[1] as string));
        return json(
          200,
          issue.labels.map((name) => ({ name })),
        );
      }
      if (sub === "/assignees" && method === "POST") {
        issue.assignees.push(...(body.assignees as string[]));
        return json(201, issueOut(issue));
      }
      if (sub === "/reactions" && method === "POST") {
        const reaction = { id: id(), content: String(body.content), user: as };
        issue.reactions.push(reaction);
        return json(201, { id: reaction.id, content: reaction.content, created_at: now() });
      }
    }
    return refuse(404, `The stub doesn't answer ${route}`);
  };

  const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const credential = (request.headers.get("authorization") ?? "").replace(/^(token|bearer) /i, "");
    const as = credential.startsWith("ey")
      ? "app"
      : credential === installationToken
        ? "installation"
        : (tokens.get(credential) ?? "nobody");
    const method = request.method.toUpperCase();
    const path = decodeURIComponent(url.pathname);
    calls.push({ method, path, as });
    const text = method === "GET" || method === "HEAD" ? "" : await request.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (as === "nobody") return refuse(401, "Bad credentials");
    return handle(as, method, path, body, request.headers.get("accept") ?? "");
  }) as typeof fetch;

  return {
    url: "https://github.stub",
    fetch: stubFetch,
    org,
    app,
    privateKey,
    calls,
    person(login, personOptions = {}) {
      const token = `ghp_${randomString(36, hex)}`;
      const user = { id: id(), login, type: personOptions.type ?? "User" };
      people.set(login, user);
      tokens.set(token, login);
      return { token, id: user.id };
    },
    selectOnly() {
      selection = "selected";
    },
    onUserAccount() {
      accountType = "User";
    },
    agentComments(name, number, body, delivery = {}) {
      const repo = repos.get(name);
      const issue = repo?.issues.find((candidate) => candidate.number === number);
      if (!repo || !issue) throw new Error(`No issue ${name}#${number}`);
      const status = delivery.status ?? 200;
      deliveries.push({
        id: id(),
        guid: `${randomString(8, hex)}-${randomString(4, hex)}-${randomString(4, hex)}-${randomString(4, hex)}-${randomString(12, hex)}`,
        delivered_at: now(),
        duration: 0.25,
        status: status === 200 ? "OK" : `Invalid HTTP Response: ${status}`,
        status_code: status,
        event: "issue_comment",
        action: "created",
        repository_id: repo.id,
        payload: { action: "created", issue: { number } },
      });
      issue.comments.push({ id: id(), body, user: `${app.slug}[bot]`, at: now() });
    },
    repo(name) {
      const repo = repos.get(name);
      return (
        repo && {
          name: repo.name,
          deleted: repo.deleted,
          collaborators: [...repo.collaborators.keys()],
          labels: [...repo.labels.values()].map((label) => label.name),
        }
      );
    },
  };
}
