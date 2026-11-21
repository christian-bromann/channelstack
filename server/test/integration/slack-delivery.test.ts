import type { Server } from "node:http";

import { App, LogLevel } from "@slack/bolt";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { freePort } from "../../../scripts/lib/process.ts";
import { waitFor } from "../../../sdks/typescript/runtime/wait.ts";
import { type RunningBinary, startBinary } from "./harness.ts";

/**
 * Exit check 1.3: the fake signs like Slack. The fake's real delivery code, in the compiled
 * binary, sends to a Bolt app, Slack's official receiver. Cases S1 and S6 to S8 of the appendix
 * in docs/phases.md; S2 to S5 need the interactions of phase 2.
 */

interface Seen {
  type: string;
  text: string;
  retryNum: number | undefined;
  retryReason: string | undefined;
}

let server: RunningBinary;
let bolt: App;
let listener: Server;
const seen: Seen[] = [];

beforeAll(async () => {
  const port = await freePort();
  server = await startBinary({ env: { CHANNELSTACK_SLACK_WEBHOOK_URL: `http://127.0.0.1:${port}/slack/events` } });
  const env = (await server.control("GET", "/env")).body as {
    SLACK_BOT_TOKEN: string;
    SLACK_SIGNING_SECRET: string;
    SLACK_API_URL: string;
  };

  // A Bolt app as a developer would write it, pointed at the fake with the options Bolt already has.
  bolt = new App({
    token: env.SLACK_BOT_TOKEN,
    signingSecret: env.SLACK_SIGNING_SECRET,
    clientOptions: { slackApiUrl: env.SLACK_API_URL },
    logLevel: LogLevel.ERROR,
  });
  bolt.event("app_mention", async ({ event, context, say }) => {
    seen.push({ type: event.type, text: event.text, retryNum: context.retryNum, retryReason: context.retryReason });
    // Answer once, in the thread: a retry of the same event must not answer again.
    if (context.retryNum === undefined) await say({ text: `on it: ${event.text}`, thread_ts: event.ts });
  });
  listener = (await bolt.start(port)) as Server;
});

afterAll(async () => {
  await bolt?.stop();
  listener?.closeAllConnections?.();
  await server?.stop();
});

async function mention(text: string) {
  const { sessionId } = (await server.control("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/slack`;
  const { app } = (await server.control("GET", base)).body;
  const ana = (await server.control("POST", `${base}/users`, { name: "Ana" })).body;
  const channel = (await server.control("POST", `${base}/channels`, { participants: [ana.id, app.id] })).body;
  const message = (
    await server.control("POST", `${base}/users/${ana.id}/say`, { message: { text }, channel: channel.id })
  ).body;
  const delivery = () =>
    server.control("GET", `${base}/deliveries/${message.delivery}`).then((response) => response.body);
  const settled = () =>
    waitFor("the delivery to settle", async () => {
      const current = await delivery();
      return current.status === "pending" ? undefined : current;
    });
  const replies = () =>
    server
      .control("GET", `${base}/conversations/${channel.id}/messages/${message.ts}/replies`)
      .then((response) => response.body);
  const again = (action: "retry" | "resend", body: unknown) =>
    server.control("POST", `${base}/deliveries/${message.delivery}/${action}`, body).then((response) => response.body);
  return { app, message, settled, replies, again };
}

describe("exit check 1.3: the fake signs like Slack", () => {
  test("S1: Bolt accepts an event_callback signed with the signing secret, and answers through the fake Web API", async () => {
    const { app, settled, replies } = await mention("@my-agent summarize #812");

    const delivery = await settled();
    expect(delivery).toMatchObject({
      status: "acknowledged",
      attempts: [{ responseStatus: 200, forgedSignature: false }],
    });
    expect(seen.at(-1)).toMatchObject({
      type: "app_mention",
      text: `<@${app.botUserId}> summarize #812`,
      retryNum: undefined,
    });

    // Bolt's `say` went through auth.test and chat.postMessage on the fake.
    const [reply] = await waitFor("Bolt's reply", async () => {
      const all = await replies();
      return all.length > 0 ? all : undefined;
    });
    expect(reply).toMatchObject({ text: `on it: <@${app.botUserId}> summarize #812`, author: { kind: "app" } });
  });

  test("S6: a wrong signing secret is rejected with 401", async () => {
    const { settled, again } = await mention("@my-agent s6");
    await settled();
    const before = seen.length;
    expect(await again("resend", { badSignature: true })).toMatchObject({
      status: "failed",
      responseStatus: 401,
      forgedSignature: true,
    });
    expect(seen).toHaveLength(before);
  });

  test("S7: a timestamp six minutes old is rejected with 401", async () => {
    const { settled, again } = await mention("@my-agent s7");
    await settled();
    const before = seen.length;
    expect(await again("resend", { stale: true })).toMatchObject({
      status: "failed",
      responseStatus: 401,
      forgedSignature: true,
    });
    expect(seen).toHaveLength(before);
  });

  test("S8: the retry headers reach the handler as context.retryNum and context.retryReason", async () => {
    const { settled, again, replies } = await mention("@my-agent s8");
    await settled();

    expect(await again("retry", { after: 0, reason: "http_timeout" })).toMatchObject({
      number: 2,
      status: "acknowledged",
    });
    expect(seen.at(-1)).toMatchObject({ retryNum: 1, retryReason: "http_timeout" });
    // The handler saw the retry and didn't answer twice.
    await waitFor("Bolt's reply", async () => ((await replies()).length > 0 ? true : undefined));
    expect(await replies()).toHaveLength(1);
  });
});
