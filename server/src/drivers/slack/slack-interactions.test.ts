import { afterEach, describe, expect, test } from "vitest";

import { refusal, signedBy, slackWorkspace } from "../../../test/slack-workspace.ts";

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function workspace() {
  const space = await slackWorkspace();
  closers.push(space.agent.close);
  /** What the agent received last, with a form body's `payload` field parsed. */
  const last = () => {
    // An interaction is a form; the events around it (the app hearing its own answer) are JSON.
    const delivery = space.agent.received.findLast(({ headers }) => String(headers["content-type"]).includes("form"));
    if (!delivery) throw new Error("The agent received nothing");
    const form = new URLSearchParams(delivery.body);
    return {
      delivery,
      contentType: delivery.headers["content-type"],
      form: Object.fromEntries(form),
      payload: form.has("payload") ? JSON.parse(form.get("payload") ?? "{}") : undefined,
    };
  };
  return { ...space, last };
}

const APPROVAL = [
  { type: "section", text: { type: "mrkdwn", text: "Deploy *web* to staging?" } },
  {
    type: "actions",
    block_id: "approval",
    elements: [
      { type: "button", action_id: "approve", value: "web:staging", text: { type: "plain_text", text: "Approve" } },
      { type: "button", action_id: "deny", text: { type: "plain_text", text: "Deny" }, style: "danger" },
      {
        type: "static_select",
        action_id: "environment",
        placeholder: { type: "plain_text", text: "Environment" },
        options: [
          { text: { type: "plain_text", text: "staging" }, value: "env-staging" },
          { text: { type: "plain_text", text: "production" }, value: "env-production" },
        ],
      },
    ],
  },
];

describe("buttons and menus", () => {
  test("a click sends block_actions as a signed form payload, the way Slack does", async () => {
    const { h, agent, app, team, ana, channel, say, api, post, get, last } = await workspace();
    const question = await say("@my-agent deploy web to staging");
    const ask = await api("chat.postMessage", {
      channel: channel.id,
      thread_ts: question.ts,
      text: "Deploy?",
      blocks: APPROVAL,
    });
    await h.app.settled();

    const clicked = await post(`/users/${ana.id}/click`, {
      button: { label: "Approve" },
      message: { channel: channel.id, ts: ask.ts },
    });
    await h.app.settled();

    expect(clicked).toMatchObject({ channel: "slack", type: "block_actions" });
    expect((await get(`/deliveries/${clicked.id}`)).status).toBe("acknowledged");
    const { delivery, contentType, payload } = last();
    expect(contentType).toBe("application/x-www-form-urlencoded");
    expect(signedBy(delivery, app.signingSecret)).toBe(true);
    // Interactions are not retried, and say so by carrying no retry headers.
    expect(delivery.headers["x-slack-retry-num"]).toBeUndefined();
    expect(payload).toMatchObject({
      type: "block_actions",
      user: { id: ana.id, username: "ana", name: "ana", team_id: team.id },
      api_app_id: app.id,
      team: { id: team.id },
      container: {
        type: "message",
        message_ts: ask.ts,
        channel_id: channel.id,
        is_ephemeral: false,
        thread_ts: question.ts,
      },
      channel: { id: channel.id },
      message: { ts: ask.ts, text: "Deploy?", bot_id: app.botId, thread_ts: question.ts },
      actions: [
        {
          type: "button",
          action_id: "approve",
          block_id: "approval",
          value: "web:staging",
          text: { type: "plain_text", text: "Approve" },
        },
      ],
    });
    expect(payload.trigger_id).toMatch(/^\d{13}\.\d{13}\.[0-9a-f]{32}$/);
    expect(payload.response_url).toMatch(/^http:\/\/127\.0\.0\.1:4500\/slack\/hooks\/actions\//);
    expect(payload.actions[0].action_ts).toMatch(/^\d{10}\.\d{6}$/);
    expect(agent.received.filter(({ body }) => body.startsWith("payload="))).toHaveLength(1);
  });

  test("a button is found by action_id too, in the latest message of a thread or channel that has it", async () => {
    const { h, ana, channel, say, api, post, last } = await workspace();
    const question = await say("@my-agent deploy");
    await api("chat.postMessage", { channel: channel.id, thread_ts: question.ts, text: "Deploy?", blocks: APPROVAL });
    await api("chat.postMessage", { channel: channel.id, thread_ts: question.ts, text: "(no buttons here)" });
    await h.app.settled();

    await post(`/users/${ana.id}/click`, {
      button: { actionId: "deny" },
      thread: { channel: channel.id, ts: question.ts },
    });
    await h.app.settled();
    expect(last().payload.actions[0]).toMatchObject({ action_id: "deny", text: { text: "Deny" } });

    await post(`/users/${ana.id}/click`, { button: { label: "Approve" }, channel: channel.id });
    await h.app.settled();
    expect(last().payload.actions[0].action_id).toBe("approve");

    // A button nobody can see can't be clicked, and the refusal says what is there.
    const missing = post(`/users/${ana.id}/click`, { button: { label: "Merge" }, channel: channel.id });
    expect(await refusal(missing)).toBe("not_found");
    await expect(missing).rejects.toMatchObject({ body: { message: expect.stringContaining("Approve, Deny") } });
  });

  test("choosing from a select menu sends the chosen option", async () => {
    const { h, ana, channel, api, post, last } = await workspace();
    const ask = await api("chat.postMessage", { channel: channel.id, text: "Where?", blocks: APPROVAL });
    const message = { channel: channel.id, ts: ask.ts };
    await h.app.settled();

    const chosen = await post(`/users/${ana.id}/select`, {
      option: ["staging"],
      menu: { label: "Environment" },
      message,
    });
    await h.app.settled();
    expect(chosen.type).toBe("block_actions");
    expect(last().payload.actions).toMatchObject([
      {
        type: "static_select",
        action_id: "environment",
        block_id: "approval",
        selected_option: { text: { type: "plain_text", text: "staging" }, value: "env-staging" },
      },
    ]);
    // The option is found by its value as well; one that isn't offered is refused.
    await post(`/users/${ana.id}/select`, { option: ["env-production"], menu: { actionId: "environment" }, message });
    await h.app.settled();
    expect(last().payload.actions[0].selected_option.value).toBe("env-production");
    expect(
      await refusal(post(`/users/${ana.id}/select`, { option: ["qa"], menu: { label: "Environment" }, message })),
    ).toBe("not_found");
  });

  test("only someone who can see the message can act on it", async () => {
    const { h, channel, api, post } = await workspace();
    const ask = await api("chat.postMessage", { channel: channel.id, text: "Deploy?", blocks: APPROVAL });
    await h.app.settled();
    const outsider = await post("/users", { name: "Ben" });
    expect(
      await refusal(
        post(`/users/${outsider.id}/click`, {
          button: { label: "Approve" },
          message: { channel: channel.id, ts: ask.ts },
        }),
      ),
    ).toBe("not_in_channel");
  });
});

describe("response_url", () => {
  test("the app answers a click through its response_url: replace the message, or add one", async () => {
    const { h, ana, channel, api, post, get, last } = await workspace();
    const ask = await api("chat.postMessage", { channel: channel.id, text: "Deploy?", blocks: APPROVAL });
    await h.app.settled();
    await post(`/users/${ana.id}/click`, {
      button: { label: "Approve" },
      message: { channel: channel.id, ts: ask.ts },
    });
    await h.app.settled();
    const { response_url: url } = last().payload;
    const respond = async (body: unknown) => {
      const response = await h.app.fetch(new Request(url, { method: "POST", body: JSON.stringify(body) }));
      return [response.status, await response.text()];
    };

    // By default the answer replaces the message the button was on.
    expect(await respond({ text: "Deploying web to staging…" })).toEqual([200, "ok"]);
    expect((await get(`/conversations/${channel.id}/transcript`)).text).toBe(
      "my-agent: Deploying web to staging… (edited)",
    );
    // `replace_original: false` adds a message: only for the person who clicked, unless it says in_channel.
    await respond({ text: "Only you see this", replace_original: false });
    await respond({ text: "Everyone sees this", replace_original: false, response_type: "in_channel" });
    expect((await get(`/conversations/${channel.id}/transcript?as=${ana.id}`)).text).toBe(
      [
        "my-agent: Deploying web to staging… (edited)",
        "my-agent: Only you see this (only Ana sees this)",
        "my-agent: Everyone sees this",
      ].join("\n"),
    );
    // `delete_original` removes it. A response_url works five times, then no more.
    expect(await respond({ delete_original: true })).toEqual([200, "ok"]);
    expect((await get(`/conversations/${channel.id}/transcript`)).text).toBe("my-agent: Everyone sees this");
    expect(await respond({ text: "five" })).toEqual([200, "ok"]);
    expect((await respond({ text: "six" }))[0]).toBe(404);
  });
});

describe("shortcuts and slash commands", () => {
  test("a message shortcut sends message_action with the message it was run on", async () => {
    const { h, app, ana, channel, say, post, last } = await workspace();
    const report = await say("checkout returns 500 for EU users");
    await h.app.settled();

    const ran = await post(`/users/${ana.id}/shortcut`, {
      callbackId: "create_ticket",
      message: { channel: channel.id, ts: report.ts },
    });
    await h.app.settled();
    expect(ran).toMatchObject({ type: "message_action" });
    const { delivery, payload } = last();
    expect(signedBy(delivery, app.signingSecret)).toBe(true);
    expect(payload).toMatchObject({
      type: "message_action",
      callback_id: "create_ticket",
      user: { id: ana.id },
      channel: { id: channel.id },
      message_ts: report.ts,
      message: { type: "message", user: ana.id, ts: report.ts, text: "checkout returns 500 for EU users" },
    });
    expect(payload.trigger_id).toBeDefined();
    expect(payload.response_url).toBeDefined();
  });

  test("a slash command arrives as form fields, and the answer in the HTTP body is shown", async () => {
    const { h, agent, app, team, ana, channel, post, get, last } = await workspace();
    agent.respond = () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", text: "Deploying web to staging" }),
    });

    const command = await post(`/users/${ana.id}/commands`, { command: "/deploy web staging", channel: channel.id });
    await h.app.settled();

    expect(command).toMatchObject({ type: "slash_command" });
    expect((await get(`/deliveries/${command.id}`)).status).toBe("acknowledged");
    const { delivery, contentType, form } = last();
    expect(contentType).toBe("application/x-www-form-urlencoded");
    expect(signedBy(delivery, app.signingSecret)).toBe(true);
    expect(form).toMatchObject({
      command: "/deploy",
      text: "web staging",
      user_id: ana.id,
      user_name: "ana",
      channel_id: channel.id,
      team_id: team.id,
      api_app_id: app.id,
      is_enterprise_install: "false",
    });
    expect(form.trigger_id).toMatch(/^\d{13}\.\d{13}\.[0-9a-f]{32}$/);
    expect(form.response_url).toMatch(/\/slack\/hooks\/commands\//);
    // The immediate answer is the app's message in the channel.
    expect((await get(`/conversations/${channel.id}/transcript`)).text).toBe("my-agent: Deploying web to staging");

    // A plain-text answer, or one without `in_channel`, is for the person who ran the command.
    agent.respond = () => ({ status: 200, body: "On it." });
    await post(`/users/${ana.id}/commands`, { command: "/deploy", channel: channel.id });
    await h.app.settled();
    expect(last().form.text).toBe("");
    expect((await get(`/users/${ana.id}/ephemeral`)).at(-1)).toMatchObject({ text: "On it." });
    // An empty 200 says nothing.
    agent.respond = () => ({ status: 200 });
    await post(`/users/${ana.id}/commands`, { command: "/deploy web", channel: channel.id });
    await h.app.settled();
    expect(await get(`/users/${ana.id}/ephemeral`)).toHaveLength(1);
  });
});
