import { createPrivateKey } from "node:crypto";

import { SignJWT } from "jose";

import { harness, recordingAgent } from "./app-harness.ts";
import { restProblems, webhookProblems } from "./github-schemas.ts";

/**
 * A GitHub org for a unit test: the app in memory, a stand-in agent, one session with Ana and a
 * repository the App is installed on. `api` calls the fake REST API as the App's installation and
 * holds every answer to GitHub's REST description; `post` and `get` call the control API. Close
 * the agent when the test ends. With `reachable: false` the App has no webhook URL.
 */
export async function githubWorkspace({ reachable = true }: { reachable?: boolean } = {}) {
  const agent = await recordingAgent();
  const h = harness(reachable ? { github: agent.url } : {});
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/github`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await h.call(method, `${base}${path}`, body);
    // An internal error says why in the app's log, not in its answer.
    const why = response.status === 500 ? `: ${h.logs.slice(-2).join(" ")}` : "";
    if (response.status >= 400) throw Object.assign(new Error(`${response.body.error}${why}`), response);
    return response.body;
  };
  const post = (path: string, body?: unknown) => call("POST", path, body);
  const get = (path: string) => call("GET", path);
  const { app, org } = await get("");
  const ana = await post("/users", { login: "ana" });
  const repo = await post("/repos", { collaborators: [{ user: ana.id }], apps: [app.id] });

  /** The JWT an App authenticates with, signed with the key `channelstack env` hands the agent. */
  const jwt = (claims: { iss?: string; expiresIn?: number } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(claims.iss ?? String(app.appId))
      .setIssuedAt(now - 30)
      .setExpirationTime(now + (claims.expiresIn ?? 540))
      .sign(createPrivateKey(app.privateKey));
  };
  /** Call the REST API with the App's JWT. */
  const asApp = async (method: string, path: string, body?: unknown) =>
    h.provider(method, `github${path}`, body, await jwt());
  let token: string | undefined;
  /** What the REST answers so far got wrong by GitHub's description. A test ends by expecting none. */
  const problems: string[] = [];
  /** Call the REST API as the App's installation, the way Octokit does after exchanging its JWT for a token. */
  const api = async (method: string, path: string, body?: unknown) => {
    token ??= (await asApp("POST", `/app/installations/${await installationId()}/access_tokens`)).body.token;
    const response = await h.provider(method, `github${path}`, body, token);
    problems.push(...restProblems(method, path.split("?")[0] ?? path, response.status, response.body));
    return response;
  };
  const installationId = async (): Promise<number> => (await asApp("GET", "/app/installations")).body[0].id;

  /** What the agent received, as webhooks: the event, the GUID and the parsed payload. */
  const webhooks = () =>
    agent.received.map(({ headers, body }) => ({
      event: String(headers["x-github-event"]),
      guid: String(headers["x-github-delivery"]),
      headers,
      body,
      payload: JSON.parse(body),
    }));
  /** What the webhooks so far got wrong by GitHub's schemas. */
  const webhookIssues = () => webhooks().flatMap(({ event, payload }) => webhookProblems(event, payload));
  /** Call the REST API with any Authorization header (or none), and see the whole response. */
  const raw = (method: string, path: string, authorization?: string, body?: unknown) =>
    h.app.fetch(
      new Request(`http://127.0.0.1:4500/github${path}`, {
        method,
        headers: {
          ...(authorization ? { authorization } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const name = (kind: string) => `${kind}/${repo.owner}/${repo.name}`;

  return {
    h,
    agent,
    sessionId,
    app,
    org,
    ana,
    repo,
    post,
    get,
    jwt,
    asApp,
    api,
    raw,
    /** The installation token, once `api` has exchanged the App's JWT for it. */
    token: async () => {
      await api("GET", `/${name("repos")}`);
      return token ?? "";
    },
    problems,
    webhooks,
    webhookIssues,
    /** `/repos/acme/<name>`: the REST path of the repository. */
    path: `/${name("repos")}`,
  };
}
