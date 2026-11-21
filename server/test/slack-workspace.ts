import { createHmac } from "node:crypto";

import { harness, type RecordingAgent, recordingAgent } from "./app-harness.ts";

/**
 * A Slack workspace for a unit test: the app in memory, a stand-in agent, one session with Ana
 * and a channel she shares with the app. `api` calls the fake Web API as the app, `post` and
 * `get` the control API. Close the agent when the test ends. With `reachable: false` the app has
 * no request URL (and no socket until it opens one): Slack has nowhere to send anything.
 */
export async function slackWorkspace({ reachable = true }: { reachable?: boolean } = {}) {
  const agent = await recordingAgent();
  const h = harness(reachable ? { slack: agent.url } : {});
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/slack`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await h.call(method, `${base}${path}`, body);
    if (response.status >= 400) throw Object.assign(new Error(response.body.error), response);
    return response.body;
  };
  const post = (path: string, body?: unknown) => call("POST", path, body);
  const get = (path: string) => call("GET", path);
  const { app, team } = await get("");
  const ana = await post("/users", { name: "Ana" });
  const channel = await post("/channels", { participants: [ana.id, app.id] });
  const say = (text: string) => post(`/users/${ana.id}/say`, { message: { text }, channel: channel.id });
  const api = async (method: string, args: Record<string, unknown> = {}) =>
    (await h.provider("POST", `slack/api/${method}`, args, app.botToken)).body;
  return { h, agent, sessionId, app, team, ana, channel, post, get, say, api };
}

/** The error code a control API call was refused with, or "no error". */
export const refusal = (run: Promise<unknown>) =>
  run.then(
    () => "no error",
    (error: { body?: { error: string } }) => error.body?.error,
  );

/** Does a delivery carry a valid Slack signature for this signing secret, the way Bolt checks it? */
export function signedBy(delivery: RecordingAgent["received"][number], signingSecret: string): boolean {
  const timestamp = String(delivery.headers["x-slack-request-timestamp"]);
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${delivery.body}`).digest("hex")}`;
  return delivery.headers["x-slack-signature"] === expected && Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
}
