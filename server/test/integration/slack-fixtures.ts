import { waitFor } from "../../../sdks/typescript/runtime/wait.ts";
import type { RunningBinary } from "./harness.ts";

/** A session with Ana in a channel with the app, on a running server, and what a test needs to act and look. */
export async function slackSession(server: RunningBinary) {
  const { sessionId } = (await server.control("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/slack`;
  const fixture = async () => (await server.control("GET", base)).body;
  const { app } = await fixture();
  const ana = (await server.control("POST", `${base}/users`, { name: "Ana" })).body;
  const channel = (await server.control("POST", `${base}/channels`, { participants: [ana.id, app.id] })).body;
  const act = (path: string, body?: unknown) =>
    server.control("POST", `${base}${path}`, body).then((response) => response.body);
  const settled = (id: string) =>
    waitFor("the delivery to settle", async () => {
      const current = (await server.control("GET", `${base}/deliveries/${id}`)).body;
      return current.status === "pending" ? undefined : current;
    });
  return { base, fixture, app, ana, channel, act, settled };
}

/** A modal with one required text input, as the Bolt receivers in the delivery tests open it. */
export const SUMMARY_VIEW = {
  type: "modal" as const,
  callback_id: "incident",
  title: { type: "plain_text" as const, text: "File an incident" },
  submit: { type: "plain_text" as const, text: "File" },
  blocks: [
    {
      type: "input",
      block_id: "summary",
      label: { type: "plain_text", text: "Summary" },
      element: { type: "plain_text_input", action_id: "text" },
    },
  ],
};
