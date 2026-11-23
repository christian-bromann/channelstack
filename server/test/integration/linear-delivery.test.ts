import { createServer, type Server } from "node:http";

import { LinearWebhookClient } from "@linear/sdk/webhooks";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { freePort } from "../../../scripts/lib/process.ts";
import { waitFor } from "../../../sdks/typescript/runtime/wait.ts";
import { type RunningBinary, startBinary } from "./harness.ts";

/**
 * The fake signs like Linear (exit check 4.4). The fake's real delivery code, in the compiled
 * binary, sends to `LinearWebhookClient`, Linear's own receiver, which checks the signature over
 * the body and the `webhookTimestamp` inside it. Cases L1 to L3 of the appendix in docs/phases.md.
 */

let server: RunningBinary;
let listener: Server;
/** What the receiver verified and dispatched. */
const dispatched: Array<{ action: string; session: string; signal: string | undefined; at: number }> = [];

beforeAll(async () => {
  const port = await freePort();
  server = await startBinary({ env: { CHANNELSTACK_LINEAR_WEBHOOK_URL: `http://127.0.0.1:${port}/webhooks/linear` } });
  const env = (await server.control("GET", "/env")).body as { LINEAR_WEBHOOK_SECRET: string };
  // The receiver as Linear's agent guide sets it up: the webhook secret, a handler per event type.
  const handler = new LinearWebhookClient(env.LINEAR_WEBHOOK_SECRET).createHandler();
  handler.on("AgentSessionEvent", (event) => {
    dispatched.push({
      action: event.action,
      session: event.agentSession.id,
      signal: event.agentActivity?.signal ?? undefined,
      at: event.webhookTimestamp,
    });
  });
  listener = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const response = await handler(
      new Request(`http://127.0.0.1:${port}${incoming.url}`, {
        method: incoming.method ?? "POST",
        headers: incoming.headers as Record<string, string>,
        body: Buffer.concat(chunks),
      }),
    );
    outgoing.writeHead(response.status).end(await response.text());
  });
  await new Promise<void>((resolve) => listener.listen(port, "127.0.0.1", resolve));
});

afterAll(async () => {
  listener?.closeAllConnections();
  listener?.close();
  await server?.stop();
});

/** A session with Ana, who delegates an issue to the app. */
async function delegated() {
  const { sessionId } = (await server.control("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/linear`;
  const act = (path: string, body?: unknown) =>
    server.control("POST", `${base}${path}`, body).then((reply) => reply.body);
  const { app } = (await server.control("GET", base)).body;
  const ana = await act("/users", { name: "Ana" });
  const team = await act("/teams", { members: [ana.id] });
  const issue = await act(`/users/${ana.id}/issues`, { issue: { title: "Signed" }, team: team.id });
  const session = await act(`/users/${ana.id}/delegate`, { app: app.id, issue: issue.id });
  const settled = (id: string) =>
    waitFor("the delivery to settle", async () => {
      const current = (await server.control("GET", `${base}/deliveries/${id}`)).body;
      return current.attempts.at(-1)?.status === "pending" ? undefined : current;
    });
  await settled(session.delivery.id);
  return { base, act, ana, session, settled };
}

describe("the fake signs like Linear", () => {
  test("L1: LinearWebhookClient accepts a prompted webhook with the stop signal", async () => {
    const { base, act, ana, session, settled } = await delegated();
    await act(`/users/${ana.id}/stop`, { session: session.id });
    const deliveries = (await server.control("GET", `${base}/deliveries`)).body as Array<{
      id: string;
      action: string;
    }>;
    const prompted = deliveries.find((delivery) => delivery.action === "prompted");
    if (!prompted) throw new Error("Stop sent no prompted webhook");
    expect((await settled(prompted.id)).status).toBe("acknowledged");
    expect(dispatched).toContainEqual(
      expect.objectContaining({ action: "prompted", session: session.id, signal: "stop" }),
    );
  });

  test("L2: sent again after more than a minute, the timestamp in the signed body makes it stale: 400", async () => {
    const { act, session, settled } = await delegated();
    const attempt = await act(`/deliveries/${session.delivery.id}/resend`, { stale: true });
    expect(attempt).toMatchObject({ forgedSignature: true });
    const delivery = await settled(session.delivery.id);
    expect(delivery.attempts.at(-1)).toMatchObject({ status: "failed", responseStatus: 400 });
  });

  test("L3: a redelivery carries a new webhookTimestamp and a new signature, and is accepted", async () => {
    const { act, session, settled } = await delegated();
    const first = (await settled(session.delivery.id)).attempts[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
    await act(`/deliveries/${session.delivery.id}/redeliver`);
    const delivery = await settled(session.delivery.id);
    const again = delivery.attempts.at(-1);
    expect(again).toMatchObject({ status: "acknowledged" });
    expect(again.requestHeaders["linear-signature"]).not.toBe(first.requestHeaders["linear-signature"]);
    const stamps = dispatched
      .filter((event) => event.session === session.id && event.action === "created")
      .map((event) => event.at);
    expect(stamps).toHaveLength(2);
    expect(stamps[1]).toBeGreaterThan(stamps[0] ?? Number.POSITIVE_INFINITY);
  });
});
