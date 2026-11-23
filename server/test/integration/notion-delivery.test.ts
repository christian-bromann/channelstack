import { createServer, type Server } from "node:http";

import notionClient from "@notionhq/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { freePort } from "../../../scripts/lib/process.ts";
import { waitFor } from "../../../sdks/typescript/runtime/wait.ts";
import { type RunningBinary, startBinary } from "./harness.ts";

/**
 * The fake signs like Notion (exit check 4.4). The fake's real delivery code, in the compiled
 * binary, sends to a receiver that checks every event with `verifyWebhookSignature` from
 * `@notionhq/client`. Cases N1 to N3 of the appendix in docs/phases.md.
 */

// The package is CommonJS: Node gives it to an ES module as its default export.
const { verifyWebhookSignature, signWebhookPayload } = notionClient;

let server: RunningBinary;
let listener: Server;
let verificationToken: string;
/** What arrived: the exact bytes and the signature over them. */
const arrived: Array<{ raw: string; signature: string }> = [];

beforeAll(async () => {
  const port = await freePort();
  server = await startBinary({ env: { CHANNELSTACK_NOTION_WEBHOOK_URL: `http://127.0.0.1:${port}/webhooks/notion` } });
  verificationToken = ((await server.control("GET", "/env")).body as { NOTION_VERIFICATION_TOKEN: string })
    .NOTION_VERIFICATION_TOKEN;
  // The receiver as Notion's webhook guide has it: verify the bytes as they came, then parse.
  listener = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const signature = String(incoming.headers["x-notion-signature"] ?? "");
    arrived.push({ raw, signature });
    const valid = await verifyWebhookSignature({ body: raw, signature, verificationToken });
    outgoing.writeHead(valid ? 200 : 401).end();
  });
  await new Promise<void>((resolve) => listener.listen(port, "127.0.0.1", resolve));
});

afterAll(async () => {
  listener?.closeAllConnections();
  listener?.close();
  await server?.stop();
});

/** A session with Ana commenting on a page the integration is connected to. */
async function commented(text: string) {
  const { sessionId } = (await server.control("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/notion`;
  const act = (path: string, body?: unknown) =>
    server.control("POST", `${base}${path}`, body).then((reply) => reply.body);
  const { app } = (await server.control("GET", base)).body;
  const ana = await act("/users", { name: "Ana" });
  const page = await act("/pages", { title: "Signed", connections: [app.id] });
  const comment = await act(`/users/${ana.id}/comment`, { text, page: page.id });
  const delivery = await waitFor("the delivery to settle", async () => {
    const current = (await server.control("GET", `${base}/deliveries/${comment.delivery.id}`)).body;
    return current.attempts.at(-1)?.status === "pending" ? undefined : current;
  });
  const sent = arrived.find((entry) => JSON.parse(entry.raw).entity?.id === comment.id);
  if (!sent) throw new Error("The delivery never arrived");
  return { delivery, sent };
}

describe("the fake signs like Notion", () => {
  test("N1: signed with the verification token, verifyWebhookSignature accepts it", async () => {
    const { delivery, sent } = await commented("@my-agent N1");
    expect(delivery.status).toBe("acknowledged");
    expect(sent.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await verifyWebhookSignature({ body: sent.raw, signature: sent.signature, verificationToken })).toBe(true);
  });

  test("N2: the same event serialized again doesn't verify with the original signature", async () => {
    const { sent } = await commented("@my-agent N2 – naïve receivers parse first");
    const again = JSON.stringify(JSON.parse(sent.raw), null, 2);
    expect(JSON.parse(again)).toEqual(JSON.parse(sent.raw));
    expect(await verifyWebhookSignature({ body: again, signature: sent.signature, verificationToken })).toBe(false);
  });

  test("N3: signed again over the bytes that were sent, it verifies: the fake signs exactly what it sends", async () => {
    const { sent } = await commented("@my-agent N3");
    const resigned = await signWebhookPayload({ body: sent.raw, verificationToken });
    expect(resigned).toBe(sent.signature);
    expect(await verifyWebhookSignature({ body: sent.raw, signature: resigned, verificationToken })).toBe(true);
  });
});
