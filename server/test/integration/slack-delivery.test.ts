import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { App, LogLevel } from "@slack/bolt";
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from "vitest";

import { freePort } from "../../../scripts/lib/process.ts";
import { connect } from "../../../sdks/typescript/client.ts";
import { waitFor } from "../../../sdks/typescript/runtime/wait.ts";
import { type RunningBinary, startBinary } from "./harness.ts";
import { slackSession, SUMMARY_VIEW } from "./slack-fixtures.ts";

/**
 * The fake signs like Slack. The fake's real delivery code, in the compiled binary, sends to a
 * Bolt app, Slack's official receiver. Cases S1 to S8 of the appendix in docs/phases.md: S1 and
 * S6 to S8 are exit check 1.3, S2 to S5 (interactions) are part of exit check 2.2.
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
/** What Bolt's interaction handlers were called with. */
const interactions: Array<{ kind: string; detail: string }> = [];
/** The files Bolt read from a person's `file_share`, by name: what `url_private` served it with the bot token. */
const downloaded: Array<{ name: string; content: string }> = [];

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
  // S2 to S5: what a person does in the client, routed by Bolt to the handler for its kind.
  bolt.action("approve", async ({ ack, body, action }) => {
    await ack();
    if (body.type === "block_actions" && action.type === "button" && "action_id" in action) {
      interactions.push({ kind: "action", detail: `${action.action_id}=${action.value} by ${body.user.id}` });
    }
  });
  bolt.view("incident", async ({ ack, view }) => {
    interactions.push({ kind: "view", detail: view.state.values.summary?.text?.value ?? "" });
    await ack({ response_action: "errors", errors: { summary: "Say what is broken" } });
  });
  bolt.command("/deploy", async ({ ack, command }) => {
    interactions.push({ kind: "command", detail: `${command.command} ${command.text} by ${command.user_id}` });
    await ack(`Deploying ${command.text}`);
  });
  bolt.event("agent_session_stopped", async ({ event }) => {
    const stopped = event as unknown as { channel: string; thread_ts: string; user: string };
    interactions.push({ kind: "stopped", detail: `${stopped.channel} ${stopped.thread_ts} by ${stopped.user}` });
  });
  // A person shares a file: the app reads it from `url_private` with its bot token, as Slack's docs say.
  bolt.message(async ({ message, context }) => {
    if (message.subtype !== "file_share") return;
    for (const file of message.files ?? []) {
      const response = await fetch(file.url_private ?? "", {
        headers: { authorization: `Bearer ${context.botToken}` },
      });
      downloaded.push({ name: file.name ?? "", content: await response.text() });
    }
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
    server.control("GET", `${base}/deliveries/${message.delivery.id}`).then((response) => response.body);
  const settled = () =>
    waitFor("the delivery to settle", async () => {
      const current = await delivery();
      return current.status === "pending" ? undefined : current;
    });
  const replies = () =>
    server
      .control("GET", `${base}/conversations/${channel.id}/threads/${message.ts}/replies`)
      .then((response) => response.body);
  const again = (action: "retry" | "resend", body: unknown) =>
    server
      .control("POST", `${base}/deliveries/${message.delivery.id}/${action}`, body)
      .then((response) => response.body);
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

describe("exit check 2.2: interactions reach Bolt's handlers, and its answers come back", () => {
  async function workspace() {
    const session = await slackSession(server);
    const handled = (kind: string) =>
      waitFor(`Bolt's ${kind} handler`, async () => interactions.findLast((seenOne) => seenOne.kind === kind));
    return { ...session, handled };
  }
  const approval = [
    {
      type: "actions",
      elements: [{ type: "button", action_id: "approve", value: "web", text: { type: "plain_text", text: "Approve" } }],
    },
  ];

  test("S2: Bolt routes a block_actions payload to the action handler", async () => {
    const { ana, channel, act, settled, handled } = await workspace();
    await bolt.client.chat.postMessage({ channel: channel.id, text: "Deploy?", blocks: approval });

    const click = await act(`/users/${ana.id}/click`, { button: { label: "Approve" }, channel: channel.id });
    expect(await settled(click.id)).toMatchObject({ type: "block_actions", status: "acknowledged" });
    expect(await handled("action")).toEqual({ kind: "action", detail: `approve=web by ${ana.id}` });
  });

  test("S3: for view_submission, the agent's response_action comes back in the HTTP response body", async () => {
    const { base, ana, channel, act, settled, handled } = await workspace();
    await bolt.client.chat.postMessage({ channel: channel.id, text: "Deploy?", blocks: approval });
    const click = await act(`/users/${ana.id}/click`, { button: { label: "Approve" }, channel: channel.id });
    const { payload } = await settled(click.id);
    const { view } = await bolt.client.views.open({
      trigger_id: payload.trigger_id,
      view: SUMMARY_VIEW,
    });

    const submitted = await act(`/modals/${view?.id}/submit`, { values: { Summary: "?" } });
    const delivery = await settled(submitted.id);
    expect(delivery).toMatchObject({ type: "view_submission", status: "acknowledged" });
    expect(JSON.parse(delivery.attempts[0].responseBody)).toEqual({
      response_action: "errors",
      errors: { summary: "Say what is broken" },
    });
    expect(await handled("view")).toEqual({ kind: "view", detail: "?" });
    // The person still has the form in front of them, with the app's complaint at the input.
    const [open] = (await server.control("GET", `${base}/users/${ana.id}/modals`)).body;
    expect(open.errors).toEqual({ Summary: "Say what is broken" });
  });

  test("S4: Bolt accepts a slash command, and its immediate reply is in the HTTP body", async () => {
    const { base, ana, channel, act, settled, handled } = await workspace();
    const command = await act(`/users/${ana.id}/commands`, { command: "/deploy web staging", channel: channel.id });

    const delivery = await settled(command.id);
    expect(delivery).toMatchObject({ type: "slash_command", status: "acknowledged" });
    expect(delivery.attempts[0].responseBody).toBe("Deploying web staging");
    expect(await handled("command")).toEqual({ kind: "command", detail: `/deploy web staging by ${ana.id}` });
    // A plain-text reply is for the person who ran the command.
    const [reply] = await waitFor("the reply to show", async () => {
      const mine = (await server.control("GET", `${base}/users/${ana.id}/ephemeral`)).body;
      return mine.length > 0 ? mine : undefined;
    });
    expect(reply.text).toBe("Deploying web staging");
  });

  test("S5: Bolt routes agent_session_stopped to the event handler", async () => {
    const { ana, channel, act, settled, handled } = await workspace();
    const question = await act(`/users/${ana.id}/say`, {
      message: { text: "write a long report" },
      channel: channel.id,
    });

    const stop = await act(`/users/${ana.id}/stop`, { thread: { channel: channel.id, ts: question.ts } });
    expect(await settled(stop.id)).toMatchObject({ eventType: "agent_session_stopped", status: "acknowledged" });
    expect(await handled("stopped")).toEqual({ kind: "stopped", detail: `${channel.id} ${question.ts} by ${ana.id}` });
  });
});

describe("a person's files reach Bolt", () => {
  test("the SDK reads a fixture from disk, and Bolt reads it back from url_private with the bot token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "channelstack-files-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, "crash.log"), "Error: disk full\n");
    const client = await connect({ mode: "attach", server: server.url, token: server.token });
    await using session = await client.openSession();
    const slack = await session.slack();
    const ana = await slack.createUser({ name: "Ana" });
    const channel = await slack.createChannel({ participants: [ana, slack.app] });
    await ana.say("the log", {
      channel,
      files: [{ path: join(directory, "crash.log") }, { name: "b.txt", content: "b" }],
    });

    expect(await waitFor("Bolt's downloads", async () => (downloaded.length >= 2 ? downloaded : undefined))).toEqual([
      { name: "crash.log", content: "Error: disk full\n" },
      { name: "b.txt", content: "b" },
    ]);
    expect(String(await channel.transcript())).toBe("Ana: the log [file: crash.log] [file: b.txt]");
  });
});
