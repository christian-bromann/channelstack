import { createServer, type Server } from "node:http";

import { createNodeMiddleware, Webhooks } from "@octokit/webhooks";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { freePort } from "../../../scripts/lib/process.ts";
import { waitFor } from "../../../sdks/typescript/runtime/wait.ts";
import { type RunningBinary, startBinary } from "./harness.ts";

/**
 * The fake signs like GitHub (exit check 3.5). The fake's real delivery code, in the compiled
 * binary, sends to `@octokit/webhooks`, GitHub's own receiver. Cases G1 to G3 of the appendix in
 * docs/phases.md.
 */

let server: RunningBinary;
let listener: Server;
let webhooks: Webhooks;
/** What `@octokit/webhooks` verified and dispatched. */
const dispatched: Array<{ id: string; name: string; body: string }> = [];
/** What arrived, before anything looked at it: the exact bytes and the signature over them. */
const arrived: Array<{ id: string; raw: string; signature: string }> = [];

beforeAll(async () => {
  const port = await freePort();
  server = await startBinary({
    env: { CHANNELSTACK_GITHUB_WEBHOOK_URL: `http://127.0.0.1:${port}/api/github/webhooks` },
  });
  const env = (await server.control("GET", "/env")).body as { GITHUB_WEBHOOK_SECRET: string };

  // The receiver as a developer sets it up: the App's webhook secret, and a handler per event.
  webhooks = new Webhooks({ secret: env.GITHUB_WEBHOOK_SECRET });
  webhooks.on("issue_comment.created", ({ id, name, payload }) => {
    dispatched.push({ id, name, body: payload.comment.body });
  });
  const middleware = createNodeMiddleware(webhooks, { path: "/api/github/webhooks" });
  listener = createServer((request, response) => {
    // Keep a copy of the bytes as they came, next to what the receiver does with them.
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () =>
      arrived.push({
        id: String(request.headers["x-github-delivery"]),
        raw: Buffer.concat(chunks).toString("utf8"),
        signature: String(request.headers["x-hub-signature-256"]),
      }),
    );
    void middleware(request, response);
  });
  await new Promise<void>((resolve) => listener.listen(port, "127.0.0.1", resolve));
});

afterAll(async () => {
  listener?.closeAllConnections();
  listener?.close();
  await server?.stop();
});

/** A session with Ana commenting on an issue of a repository the App is installed on. */
async function commented(text: string) {
  const { sessionId } = (await server.control("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/github`;
  const act = (path: string, body?: unknown) =>
    server.control("POST", `${base}${path}`, body).then((response) => response.body);
  const { app } = (await server.control("GET", base)).body;
  const ana = await act("/users", { login: "ana" });
  const repo = await act("/repos", { collaborators: [{ user: ana.id }], apps: [app.id] });
  const issue = await act(`/users/${ana.id}/issues`, { issue: { title: "Signed" }, repo: repo.id });
  const comment = await act(`/users/${ana.id}/comment`, {
    body: text,
    issue: { repoId: repo.id, number: issue.number },
  });
  const settled = () =>
    waitFor("the delivery to settle", async () => {
      const current = (await server.control("GET", `${base}/deliveries/${comment.delivery.id}`)).body;
      return current.attempts.at(-1)?.status === "pending" ? undefined : current;
    });
  return { base, act, comment, settled };
}

describe("the fake signs like GitHub", () => {
  test("G2: signed with the webhook secret over the sent bytes, @octokit/webhooks accepts and dispatches it", async () => {
    const { comment, settled } = await commented("@my-agent G2");
    const delivery = await settled();
    expect(delivery.status).toBe("acknowledged");
    // The receiver ran the handler for the event, with the delivery's GUID.
    expect(dispatched).toContainEqual({ id: comment.delivery.guid, name: "issue_comment", body: "@my-agent G2" });
    const [attempt] = delivery.attempts;
    expect(attempt.requestHeaders).toMatchObject({
      "x-github-event": "issue_comment",
      "x-github-delivery": comment.delivery.guid,
      "x-hub-signature-256": expect.stringMatching(/^sha256=[0-9a-f]{64}$/),
    });
    expect(attempt.requestHeaders["user-agent"]).toMatch(/^GitHub-Hookshot\//);
  });

  test("G1: the signature is over the exact bytes; the same payload serialized again doesn't verify", async () => {
    const { comment, settled } = await commented("@my-agent G1 – naïve receivers parse first");
    await settled();
    const sent = arrived.find((delivery) => delivery.id === comment.delivery.guid);
    if (!sent) throw new Error("The delivery never arrived");
    expect(await webhooks.verify(sent.raw, sent.signature)).toBe(true);
    // A receiver that parses the body and signs what it serializes itself has other bytes in hand.
    const again = JSON.stringify(JSON.parse(sent.raw), null, 2);
    expect(JSON.parse(again)).toEqual(JSON.parse(sent.raw));
    expect(await webhooks.verify(again, sent.signature)).toBe(false);
  });

  test("G3: a wrong secret is rejected", async () => {
    const { base, act, comment, settled } = await commented("@my-agent G3");
    await settled();
    const before = dispatched.filter((event) => event.id === comment.delivery.guid).length;
    const attempt = await act(`/deliveries/${comment.delivery.id}/resend`, { badSignature: true });
    expect(attempt).toMatchObject({ forgedSignature: true });
    const delivery = await settled();
    expect(delivery.attempts.at(-1)).toMatchObject({ status: "failed", responseStatus: 400, forgedSignature: true });
    expect(dispatched.filter((event) => event.id === comment.delivery.guid)).toHaveLength(before);
    expect((await server.control("GET", `${base}/deliveries`)).body.length).toBeGreaterThan(0);
  });
});
