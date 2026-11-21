import { App, LogLevel } from "@slack/bolt";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { waitFor } from "../../../sdks/typescript/runtime/wait.ts";
import { type RunningBinary, startBinary } from "./harness.ts";

/**
 * Exit check 2.2: Socket Mode. A Bolt app in Socket Mode, whose Slack base URL is the fake,
 * connects to the fake's WebSocket in the compiled binary. Cases K1 to K4 of the appendix in
 * docs/phases.md.
 */

let server: RunningBinary;
let bolt: App;
const handled: string[] = [];

beforeAll(async () => {
  // No request URL: the app is reached only over the connection it opens.
  server = await startBinary({});
  const env = (await server.control("GET", "/env")).body as Record<string, string>;
  bolt = new App({
    token: env.SLACK_BOT_TOKEN ?? "",
    appToken: env.SLACK_APP_TOKEN ?? "",
    socketMode: true,
    clientOptions: { slackApiUrl: env.SLACK_API_URL ?? "" },
    logLevel: LogLevel.ERROR,
  });
  bolt.event("app_mention", async ({ event }) => void handled.push(`mention: ${event.text}`));
  bolt.action("open", async ({ ack, body, client }) => {
    await ack();
    if (body.type !== "block_actions") return;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: "modal",
        callback_id: "incident",
        title: { type: "plain_text", text: "File an incident" },
        submit: { type: "plain_text", text: "File" },
        blocks: [
          {
            type: "input",
            block_id: "summary",
            label: { type: "plain_text", text: "Summary" },
            element: { type: "plain_text_input", action_id: "text" },
          },
        ],
      },
    });
  });
  bolt.view("incident", async ({ ack }) => {
    await ack({ response_action: "errors", errors: { summary: "Say what is broken" } });
  });
  bolt.command("/deploy", async ({ ack, command }) => {
    await ack({ response_type: "in_channel", text: `Deploying ${command.text}` });
  });
  await bolt.start();
});

afterAll(async () => {
  await bolt?.stop();
  await server?.stop();
});

async function workspace() {
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

describe("exit check 2.2: Socket Mode works with Bolt", () => {
  test("K1: Bolt opens a connection with its app token and connects to the fake's WebSocket", async () => {
    const { fixture } = await workspace();
    await waitFor("Bolt to connect", async () => ((await fixture()).socketConnections === 1 ? true : undefined));
  });

  test("K2: an events_api envelope is handled and acknowledged within the ack window", async () => {
    const { app, ana, channel, act, settled } = await workspace();
    const message = await act(`/users/${ana.id}/say`, { message: { text: "@my-agent k2" }, channel: channel.id });

    const delivery = await settled(message.delivery.id);
    expect(delivery).toMatchObject({ status: "acknowledged", attempts: [{ transport: "socket" }] });
    expect(delivery.attempts[0].durationMs).toBeLessThan(3000);
    await waitFor("Bolt's handler", async () =>
      handled.includes(`mention: <@${app.botUserId}> k2`) ? true : undefined,
    );
  });

  test("K3: the ack for view_submission carries response_action in its payload", async () => {
    const { base, ana, channel, act, settled } = await workspace();
    const blocks = [
      {
        type: "actions",
        elements: [{ type: "button", action_id: "open", text: { type: "plain_text", text: "Open" } }],
      },
    ];
    await bolt.client.chat.postMessage({ channel: channel.id, text: "File an incident?", blocks });
    await settled((await act(`/users/${ana.id}/click`, { button: { label: "Open" }, channel: channel.id })).id);
    const [modal] = await waitFor("the modal to open", async () => {
      const open = (await server.control("GET", `${base}/users/${ana.id}/modals`)).body;
      return open.length > 0 ? open : undefined;
    });

    const submitted = await act(`/modals/${modal.viewId}/submit`, { values: { Summary: "?" } });
    const delivery = await settled(submitted.id);
    expect(delivery).toMatchObject({
      type: "view_submission",
      status: "acknowledged",
      attempts: [{ transport: "socket" }],
    });
    expect(JSON.parse(delivery.attempts[0].responseBody)).toEqual({
      response_action: "errors",
      errors: { summary: "Say what is broken" },
    });
  });

  test("K4: the ack for a slash command carries the immediate reply", async () => {
    const { base, ana, channel, act, settled } = await workspace();
    const command = await act(`/users/${ana.id}/commands`, { command: "/deploy web staging", channel: channel.id });

    const delivery = await settled(command.id);
    expect(delivery).toMatchObject({
      type: "slash_command",
      status: "acknowledged",
      attempts: [{ transport: "socket" }],
    });
    expect(JSON.parse(delivery.attempts[0].responseBody)).toEqual({
      response_type: "in_channel",
      text: "Deploying web staging",
    });
    const transcript = await waitFor("the reply to show", async () => {
      const { text } = (await server.control("GET", `${base}/conversations/${channel.id}/transcript`)).body;
      return text === "" ? undefined : text;
    });
    expect(transcript).toBe("my-agent: Deploying web staging");
  });
});
