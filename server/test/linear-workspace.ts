import { harness, recordingAgent } from "./app-harness.ts";
import { linearResponseProblems, linearWebhookProblems } from "./schemas/linear.ts";

/**
 * A Linear workspace for a unit test: the app in memory, a stand-in agent, one session with Ana in
 * a team. `gql` calls the fake GraphQL API as the agent's app and holds every answer to Linear's
 * schema; `post` and `get` call the control API. With `reachable: false` the app has no webhook URL.
 */
export async function linearWorkspace({ reachable = true }: { reachable?: boolean } = {}) {
  const agent = await recordingAgent();
  const h = harness(reachable ? { linear: agent.url } : {});
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/linear`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await h.call(method, `${base}${path}`, body);
    const why = response.status === 500 ? `: ${h.logs.slice(-2).join(" ")}` : "";
    if (response.status >= 400) throw Object.assign(new Error(`${response.body.error}${why}`), response);
    return response.body;
  };
  const post = (path: string, body?: unknown) => call("POST", path, body);
  const get = (path: string) => call("GET", path);
  const { app } = await get("");
  const ana = await post("/users", { name: "Ana" });
  const team = await post("/teams", { key: "ENG", members: [ana.id] });

  const problems: string[] = [];
  /** A GraphQL operation as the agent's app sends it. */
  const gql = async (
    query: string,
    variables: Record<string, unknown> = {},
    token: string | null = app.accessToken,
  ) => {
    const response = await h.provider("POST", "linear/graphql", { query, variables }, token ?? undefined);
    problems.push(...linearResponseProblems({ query, variables }, response.status, response.body));
    return response;
  };
  const webhooks = () =>
    agent.received.map(({ headers, body }) => ({
      event: String(headers["linear-event"]),
      headers,
      body,
      payload: JSON.parse(body),
    }));
  const webhookIssues = () => webhooks().flatMap(({ event, payload }) => linearWebhookProblems(event, payload));
  return { h, agent, sessionId, app, ana, team, post, get, gql, problems, webhooks, webhookIssues };
}
