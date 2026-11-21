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

const INCIDENT_VIEW = {
  type: "modal",
  callback_id: "incident",
  private_metadata: "C123",
  notify_on_close: true,
  title: { type: "plain_text", text: "File an incident" },
  submit: { type: "plain_text", text: "File" },
  close: { type: "plain_text", text: "Cancel" },
  blocks: [
    {
      type: "input",
      block_id: "severity",
      label: { type: "plain_text", text: "Severity" },
      element: {
        type: "static_select",
        action_id: "pick",
        initial_option: { text: { type: "plain_text", text: "SEV3" }, value: "sev3" },
        options: ["SEV1", "SEV2", "SEV3"].map((text) => ({
          text: { type: "plain_text", text },
          value: text.toLowerCase(),
        })),
      },
    },
    {
      type: "input",
      block_id: "summary",
      label: { type: "plain_text", text: "Summary" },
      element: { type: "plain_text_input", action_id: "text" },
    },
    {
      type: "input",
      block_id: "teams",
      optional: true,
      label: { type: "plain_text", text: "Teams" },
      element: {
        type: "multi_static_select",
        action_id: "teams",
        options: ["web", "api"].map((text) => ({ text: { type: "plain_text", text }, value: text })),
      },
    },
  ],
};

describe("modals", () => {
  /** Ana clicks "Open form"; the agent has three seconds to open a modal with the click's trigger_id. */
  async function clicked() {
    const space = await workspace();
    const { h, ana, channel, api, post } = space;
    const blocks = [
      {
        type: "actions",
        elements: [{ type: "button", action_id: "open_form", text: { type: "plain_text", text: "Open form" } }],
      },
    ];
    await api("chat.postMessage", { channel: channel.id, text: "File an incident?", blocks });
    await h.app.settled();
    await post(`/users/${ana.id}/click`, { button: { label: "Open form" }, channel: channel.id });
    await h.app.settled();
    return { ...space, triggerId: space.last().payload.trigger_id as string };
  }

  test("views.open with a fresh trigger_id opens a modal for the person who clicked", async () => {
    const { ana, app, team, api, get, triggerId } = await clicked();
    expect(await get(`/users/${ana.id}/modals`)).toEqual([]);

    const opened = await api("views.open", { trigger_id: triggerId, view: INCIDENT_VIEW });
    expect(opened).toMatchObject({
      ok: true,
      view: {
        id: expect.stringMatching(/^V0[0-9A-Z]{9}$/),
        team_id: team.id,
        type: "modal",
        callback_id: "incident",
        private_metadata: "C123",
        title: { text: "File an incident" },
        state: { values: {} },
        app_id: app.id,
        bot_id: app.botId,
        notify_on_close: true,
        previous_view_id: null,
      },
    });
    expect(opened.view.root_view_id).toBe(opened.view.id);
    expect(opened.view.hash).toMatch(/^\d+\.[0-9a-zA-Z]+$/);

    const [modal] = await get(`/users/${ana.id}/modals`);
    expect(modal).toMatchObject({ viewId: opened.view.id, title: "File an incident", user: { id: ana.id } });
    // What a person sees in the form: each input by its label, with what is filled in so far.
    expect(await get(`/modals/${modal.viewId}/values`)).toEqual({ Severity: "SEV3", Summary: null, Teams: [] });

    // A trigger_id works once, for three seconds, and only if Slack issued it.
    expect((await api("views.open", { trigger_id: triggerId, view: INCIDENT_VIEW })).error).toBe(
      "exchanged_trigger_id",
    );
    expect((await api("views.open", { trigger_id: "1.2.abc", view: INCIDENT_VIEW })).error).toBe("invalid_trigger_id");
    expect((await api("views.open", { trigger_id: triggerId })).error).toBe("invalid_arguments");
  });

  test("a trigger_id expires after three seconds", async () => {
    const { h, api, triggerId } = await clicked();
    h.clock.advance(3001);
    expect((await api("views.open", { trigger_id: triggerId, view: INCIDENT_VIEW })).error).toBe("expired_trigger_id");
  });

  test("submitting sends view_submission with the state; an empty answer closes the modal", async () => {
    const { h, agent, ana, app, api, get, post, last, triggerId } = await clicked();
    const { view } = await api("views.open", { trigger_id: triggerId, view: INCIDENT_VIEW });
    // An acknowledgement with an empty body, as Bolt's `ack()` sends it.
    agent.respond = () => ({ status: 200 });

    const submitted = await post(`/modals/${view.id}/submit`, {
      values: { Severity: "SEV2", Summary: "Checkout errors", Teams: ["web", "api"] },
    });
    await h.app.settled();

    expect(submitted).toMatchObject({ type: "view_submission" });
    const { delivery, payload } = last();
    expect(signedBy(delivery, app.signingSecret)).toBe(true);
    expect(payload).toMatchObject({
      type: "view_submission",
      user: { id: ana.id },
      view: {
        id: view.id,
        callback_id: "incident",
        private_metadata: "C123",
        state: {
          values: {
            severity: { pick: { type: "static_select", selected_option: { text: { text: "SEV2" }, value: "sev2" } } },
            summary: { text: { type: "plain_text_input", value: "Checkout errors" } },
            teams: { teams: { type: "multi_static_select", selected_options: [{ value: "web" }, { value: "api" }] } },
          },
        },
      },
      response_urls: [],
    });
    expect(payload.trigger_id).toBeDefined();
    expect(await get(`/users/${ana.id}/modals`)).toEqual([]);
    expect((await api("views.update", { view_id: view.id, view: INCIDENT_VIEW })).error).toBe("not_found");
  });

  test("the app's response_action comes back in the response body: errors keep the modal open, update replaces it", async () => {
    const { h, agent, ana, api, get, post, triggerId } = await clicked();
    const { view } = await api("views.open", { trigger_id: triggerId, view: INCIDENT_VIEW });
    const json = (body: unknown) => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    agent.respond = () => json({ response_action: "errors", errors: { summary: "Say what is broken" } });
    const refused = await post(`/modals/${view.id}/submit`, { values: { Severity: "SEV1", Summary: "?" } });
    await h.app.settled();
    expect((await get(`/deliveries/${refused.id}`)).attempts[0].responseBody).toBe(
      '{"response_action":"errors","errors":{"summary":"Say what is broken"}}',
    );
    const [open] = await get(`/users/${ana.id}/modals`);
    expect(open).toMatchObject({ viewId: view.id, errors: { Summary: "Say what is broken" } });
    // An answer that is neither empty nor JSON leaves the modal as it is: the person sees an error in the client.
    agent.respond = () => ({ status: 200, body: "ok" });
    await post(`/modals/${view.id}/submit`);
    await h.app.settled();
    expect(await get(`/users/${ana.id}/modals`)).toHaveLength(1);
    // What was filled in stays filled in.
    expect((await get(`/modals/${view.id}/values`)).Severity).toBe("SEV1");

    const thanks = { type: "modal", title: { type: "plain_text", text: "Filed" }, blocks: [] };
    agent.respond = () => json({ response_action: "update", view: thanks });
    await post(`/modals/${view.id}/submit`, { values: { Summary: "Checkout errors" } });
    await h.app.settled();
    expect(await get(`/users/${ana.id}/modals`)).toMatchObject([{ viewId: view.id, title: "Filed" }]);

    // Required inputs must be filled, as in the client, and unknown inputs are refused.
    agent.respond = () => ({ status: 200 });
    expect(await refusal(post(`/modals/${view.id}/submit`, { values: { Nope: "x" } }))).toBe("not_found");
  });

  test("a required input left empty stops the submission in the client", async () => {
    const { ana, api, get, post, triggerId } = await clicked();
    const { view } = await api("views.open", { trigger_id: triggerId, view: INCIDENT_VIEW });
    const attempt = post(`/modals/${view.id}/submit`, { values: { Severity: "SEV1" } });
    expect(await refusal(attempt)).toBe("invalid_argument");
    await expect(attempt).rejects.toMatchObject({ body: { message: expect.stringContaining("Summary") } });
    expect(await get(`/users/${ana.id}/modals`)).toHaveLength(1);
  });

  test("closing tells the app when it asked to be told; views.update changes an open modal", async () => {
    const { h, agent, ana, api, get, post, last, triggerId } = await clicked();
    const { view } = await api("views.open", { trigger_id: triggerId, view: INCIDENT_VIEW });

    const updated = await api("views.update", {
      view_id: view.id,
      hash: view.hash,
      view: { ...INCIDENT_VIEW, title: { type: "plain_text", text: "File a big incident" } },
    });
    expect(updated.view).toMatchObject({ id: view.id, title: { text: "File a big incident" } });
    expect(updated.view.hash).not.toBe(view.hash);
    // An update made against an older version of the view is refused.
    expect((await api("views.update", { view_id: view.id, hash: view.hash, view: INCIDENT_VIEW })).error).toBe(
      "hash_conflict",
    );

    const closed = await post(`/modals/${view.id}/close`);
    await h.app.settled();
    expect(closed).toMatchObject({ type: "view_closed" });
    expect(last().payload).toMatchObject({ type: "view_closed", view: { id: view.id }, is_cleared: false });
    expect(await get(`/users/${ana.id}/modals`)).toEqual([]);

    // Without notify_on_close the app hears nothing, and there is no delivery to hand back.
    const channel = (await get("/conversations"))[0].id;
    await post(`/users/${ana.id}/click`, { button: { label: "Open form" }, channel });
    await h.app.settled();
    const quiet = await api("views.open", {
      trigger_id: last().payload.trigger_id,
      view: { ...INCIDENT_VIEW, notify_on_close: false },
    });
    const before = agent.received.length;
    expect(await post(`/modals/${quiet.view.id}/close`)).toBeNull();
    await h.app.settled();
    expect(agent.received).toHaveLength(before);
  });
});

describe("Stop", () => {
  test("pressing Stop ends the open stream, tells the app, and later appends are refused", async () => {
    const { h, agent, ana, team, channel, say, api, post, get } = await workspace();
    const question = await say("@my-agent write a long report");
    const thread = { channel: channel.id, ts: question.ts };
    const recipient = { recipient_user_id: ana.id, recipient_team_id: team.id };
    await api("assistant.threads.setStatus", { channel_id: channel.id, thread_ts: question.ts, status: "is writing…" });
    const stream = await api("chat.startStream", {
      channel: channel.id,
      thread_ts: question.ts,
      markdown_text: "Q3 was",
      ...recipient,
    });
    await h.app.settled();
    const status = async () => (await get(`/conversations/${channel.id}/threads/${question.ts}/state`)).state;
    expect(await status()).toBe("streaming");

    const stopped = await post(`/users/${ana.id}/stop`, { thread });
    await h.app.settled();

    expect(stopped).toMatchObject({ type: "event_callback", eventType: "agent_session_stopped" });
    expect(JSON.parse(agent.received.at(-1)?.body ?? "{}").event).toMatchObject({
      type: "agent_session_stopped",
      channel: channel.id,
      thread_ts: question.ts,
      user: ana.id,
      streaming_message_ts: [stream.ts],
    });
    expect(await status()).toBe("stopped");
    expect((await get(`/conversations/${channel.id}/messages/${stream.ts}/stream`)).state).toBe("stopped");
    // What was streamed stays; nothing more can be added to it.
    expect(
      (await api("chat.appendStream", { channel: channel.id, ts: stream.ts, markdown_text: " great" })).error,
    ).toBe("stopped_by_user");
    expect((await api("chat.stopStream", { channel: channel.id, ts: stream.ts })).error).toBe("stopped_by_user");
    expect((await get(`/conversations/${channel.id}/threads/${question.ts}/transcript`)).text).toContain(
      "my-agent: Q3 was",
    );

    // With nothing streaming, Stop still reaches the app, with no stream to name.
    await post(`/users/${ana.id}/stop`, { thread });
    await h.app.settled();
    expect(JSON.parse(agent.received.at(-1)?.body ?? "{}").event.streaming_message_ts).toEqual([]);
  });
});

describe("the agent split view", () => {
  test("opening it starts a thread in the DM, the app offers prompts, and the person picks one", async () => {
    const { h, agent, app, team, ana, channel, api, post, get } = await workspace();
    const events = () => agent.received.map(({ body }) => JSON.parse(body).event);

    const thread = await post(`/users/${ana.id}/agent-threads`, { from: channel.id });
    await h.app.settled();

    expect(thread.conversation.kind).toBe("im");
    expect(events().at(-1)).toMatchObject({
      type: "assistant_thread_started",
      assistant_thread: {
        user_id: ana.id,
        context: { channel_id: channel.id, team_id: team.id },
        channel_id: thread.channel,
        thread_ts: thread.ts,
      },
    });
    // The thread is empty until someone writes in it.
    const base = `/conversations/${thread.channel}/threads/${thread.ts}`;
    expect(await get(`${base}/replies`)).toEqual([]);
    expect((await get(`${base}/transcript`)).text).toBe("");
    expect(await get(`${base}/suggested-prompts`)).toEqual([]);

    const prompts = [{ title: "What changed?", message: "What changed in this channel today?" }];
    expect(
      await api("assistant.threads.setSuggestedPrompts", { channel_id: thread.channel, thread_ts: thread.ts, prompts }),
    ).toEqual({ ok: true });
    expect(await get(`${base}/suggested-prompts`)).toEqual(prompts);

    // Picking a prompt is the person saying its message in the thread.
    const picked = await post(`/users/${ana.id}/pick-prompt`, {
      title: "What changed?",
      thread: { channel: thread.channel, ts: thread.ts },
    });
    await h.app.settled();
    expect(picked).toMatchObject({
      text: "What changed in this channel today?",
      threadTs: thread.ts,
      author: { id: ana.id },
    });
    expect(events().at(-1)).toMatchObject({ type: "message", channel_type: "im", thread_ts: thread.ts, user: ana.id });
    expect(
      await refusal(
        post(`/users/${ana.id}/pick-prompt`, { title: "Nope", thread: { channel: thread.channel, ts: thread.ts } }),
      ),
    ).toBe("not_found");
    expect(app.id).toBeDefined();
  });

  test("moving to another channel with the view open tells the app the new context", async () => {
    const { h, agent, app, ana, team, channel, post } = await workspace();
    const thread = await post(`/users/${ana.id}/agent-threads`, {});
    const general = await post("/channels", { name: "general", participants: [ana.id, app.id] });

    const switched = await post(`/users/${ana.id}/switch-context`, {
      channel: general.id,
      thread: { channel: thread.channel, ts: thread.ts },
    });
    await h.app.settled();

    expect(switched).toMatchObject({ type: "event_callback", eventType: "assistant_thread_context_changed" });
    expect(JSON.parse(agent.received.at(-1)?.body ?? "{}").event).toMatchObject({
      type: "assistant_thread_context_changed",
      assistant_thread: {
        user_id: ana.id,
        context: { channel_id: general.id, team_id: team.id },
        channel_id: thread.channel,
        thread_ts: thread.ts,
      },
    });
    expect(channel.id).not.toBe(general.id);
  });
});
