/**
 * Exit check 12.3 for Resend: several apps (decision 0027), each a team of its own with its own
 * API key, webhook secret and URL, and receiving domain. An email one app sends another is an
 * `email.received` on the other's webhook, threaded like a person's, and the sender's team hears
 * its own `email.sent` and `email.delivered`. Each key answers as its team, and the headers an
 * agent sets are kept, `Auto-Submitted` among them.
 */
import { Resend } from "resend";
import { afterEach, describe, expect, test } from "vitest";

import { harness, type RecordingAgent, recordingAgent, refusal } from "../../../test/app-harness.ts";
import { resendWebhookProblems } from "../../../test/schemas/resend.ts";

const agents: RecordingAgent[] = [];
afterEach(() => {
  for (const agent of agents.splice(0)) agent.close();
});

/** The `resend` SDK's receiver, as an agent checks its webhooks. */
const verifier = new Resend("re_unused_by_verify");

/** A world with my-agent's team at one endpoint and `coder`'s at another. */
async function twoTeams() {
  const mine = await recordingAgent();
  const theirs = await recordingAgent();
  agents.push(mine, theirs);
  const h = harness(
    { resend: mine.url },
    { appWebhooks: (driver, app) => (driver === "resend" && app === "coder" ? theirs.url : undefined) },
  );
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/resend`;
  const post = async (path: string, body?: unknown) => {
    const response = await h.call("POST", `${base}${path}`, body);
    if (response.status >= 400) throw Object.assign(new Error(response.body.error), response);
    return response.body;
  };
  const get = async (path: string) => (await h.call("GET", `${base}${path}`)).body;
  const app = (await get("")).app;
  const coder = await post("/apps", { name: "coder" });
  /** A REST call as a team's agent makes it, with that team's key. */
  const rest = (method: string, path: string, key: string, body?: unknown) =>
    h.provider(method, `resend${path}`, body, key);
  const ana = await post("/users", { name: "Ana" });
  return { h, mine, theirs, base, post, get, app, coder, rest, ana };
}

/** The webhooks a team's endpoint got, parsed, after everything was sent. */
const events = (agent: RecordingAgent) =>
  agent.received.map((delivery) => JSON.parse(delivery.body) as { type: string; data: Record<string, any> });

/** Whether the `resend` SDK accepts a delivery with this secret. */
const verifies = (delivery: RecordingAgent["received"][number], webhookSecret: string) => {
  try {
    verifier.webhooks.verify({
      payload: delivery.body,
      headers: {
        id: String(delivery.headers["svix-id"]),
        timestamp: String(delivery.headers["svix-timestamp"]),
        signature: String(delivery.headers["svix-signature"]),
      },
      webhookSecret,
    });
    return true;
  } catch {
    return false;
  }
};

describe("exit check 12.3: Resend apps", () => {
  test("an app is a team of its own: its own key, webhook secret, domain and address; the same name gives the same team", async () => {
    const { h, post, get, app, coder } = await twoTeams();
    expect(coder).toMatchObject({
      name: "coder",
      kind: "app",
      channel: "resend",
      domain: "coder.acme.example",
      address: "coder@coder.acme.example",
    });
    expect(coder.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(coder.apiKey).toMatch(/^re_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}$/);
    expect(coder.apiKey).toBe(h.secrets.forApp("resend", "coder", "apiKey"));
    expect(coder.webhookSecret).toBe(h.secrets.forApp("resend", "coder", "webhookSecret"));
    for (const key of ["id", "address", "domain", "apiKey", "webhookSecret"]) expect(coder[key]).not.toBe(app[key]);
    expect(app).toMatchObject({ name: "my-agent", domain: "acme.example", apiKey: h.secrets.get("resend", "apiKey") });

    expect(await post("/apps", { name: "coder" })).toEqual(coder);
    expect(await post("/apps", { name: "coder", domain: "coder.acme.example" })).toEqual(coder);
    const billing = await post("/apps", { name: "billing", domain: "billing.example" });
    expect(billing.address).toBe("billing@billing.example");
    expect((await get("/apps")).map((one: { name: string }) => one.name)).toEqual(["my-agent", "coder", "billing"]);
    // A taken name with other settings, the built-in name, and a domain another team has, are refused.
    expect(await refusal(post("/apps", { name: "coder", domain: "elsewhere.example" }))).toBe("invalid_argument");
    expect(await refusal(post("/apps", { name: "my-agent" }))).toBe("invalid_argument");
    expect(await refusal(post("/apps", { name: "support", domain: "acme.example" }))).toBe("invalid_argument");
    expect(await refusal(post("/apps", { name: "support", domain: "not a domain" }))).toBe("invalid_argument");
  });

  test("each API key answers as its own team: its domain, its sending, its mail", async () => {
    const { rest, app, coder, ana } = await twoTeams();
    expect((await rest("GET", "/domains", coder.apiKey)).body.data).toEqual([
      expect.objectContaining({ name: "coder.acme.example", status: "verified" }),
    ]);
    expect((await rest("GET", "/domains", app.apiKey)).body.data).toEqual([
      expect.objectContaining({ name: "acme.example" }),
    ]);
    // A team sends from its own domain only.
    const fromMine = await rest("POST", "/emails", coder.apiKey, {
      from: app.address,
      to: ana.address,
      subject: "Hi",
      text: "Hello",
    });
    expect(fromMine).toMatchObject({ status: 403, body: { name: "validation_error" } });
    const sent = await rest("POST", "/emails", coder.apiKey, {
      from: coder.address,
      to: ana.address,
      subject: "Hi",
      text: "Hello",
    });
    expect(sent.status).toBe(200);
    // What one team sent is its own: the other's key doesn't find it.
    expect((await rest("GET", `/emails/${sent.body.id}`, coder.apiKey)).status).toBe(200);
    expect((await rest("GET", `/emails/${sent.body.id}`, app.apiKey)).status).toBe(404);
    expect((await rest("GET", "/emails", coder.apiKey)).body.data.map((one: { id: string }) => one.id)).toEqual([
      sent.body.id,
    ]);
    expect((await rest("GET", "/emails", app.apiKey)).body.data).toEqual([]);
  });

  test("an email one app sends another is an email.received on the other's webhook, threaded like a person's; the sender hears email.sent and email.delivered", async () => {
    const { h, mine, theirs, post, get, rest, app, coder, ana } = await twoTeams();
    const asked = await post(`/users/${encodeURIComponent(ana.id)}/send`, {
      to: [app.id],
      subject: "Refund",
      text: "Where is my refund?",
    });
    await h.app.settled();

    // my-agent hands off to coder, in the thread: its answer names Ana's email.
    const handoff = await rest("POST", "/emails", app.apiKey, {
      from: `my-agent <${app.address}>`,
      to: coder.address,
      subject: "Re: Refund",
      text: "Can you take this one?",
      headers: { "In-Reply-To": asked.messageId, References: asked.messageId },
    });
    await h.app.settled();
    const received = events(theirs).find((one) => one.type === "email.received");
    expect(received?.data).toMatchObject({
      email_id: handoff.body.id,
      from: app.address,
      to: [coder.address],
      subject: "Re: Refund",
    });
    expect(resendWebhookProblems("email.received", received)).toEqual([]);
    expect(
      events(mine)
        .filter((one) => one.data.email_id === handoff.body.id)
        .map((one) => one.type),
    ).toEqual(["email.sent", "email.delivered"]);

    // coder reads it with its own key (my-agent's can't: it isn't my-agent's received mail), and answers, marked automatic.
    const read = await rest("GET", `/emails/receiving/${handoff.body.id}`, coder.apiKey);
    expect(read.status).toBe(200);
    expect(read.body.headers["in-reply-to"]).toBe(asked.messageId);
    expect((await rest("GET", `/emails/receiving/${handoff.body.id}`, app.apiKey)).status).toBe(404);
    const answer = await rest("POST", "/emails", coder.apiKey, {
      from: coder.address,
      to: app.address,
      subject: "Re: Refund",
      text: "Done.",
      headers: {
        "In-Reply-To": read.body.message_id,
        References: `${asked.messageId} ${read.body.message_id}`,
        "Auto-Submitted": "auto-replied",
      },
    });
    await h.app.settled();
    const back = events(mine).find((one) => one.type === "email.received" && one.data.email_id === answer.body.id);
    expect(back?.data).toMatchObject({ from: coder.address, to: [app.address] });
    expect(
      events(theirs)
        .filter((one) => one.data.email_id === answer.body.id)
        .map((one) => one.type),
    ).toEqual(["email.sent", "email.delivered"]);
    // The receiver sees the header the sender set, and so does a test.
    const answered = await rest("GET", `/emails/receiving/${answer.body.id}`, app.apiKey);
    expect(answered.body.headers["auto-submitted"]).toBe("auto-replied");
    const thread = await get(`/threads/${asked.thread.id}/messages`);
    expect(thread.map((one: { author: { name: string } }) => one.author.name)).toEqual(["Ana", "my-agent", "coder"]);
    expect(thread[2].headers["auto-submitted"]).toBe("auto-replied");
  });

  test("A1: an email two teams receive is two deliveries, each to its own URL and signed with its own secret, which webhooks.verify tells apart", async () => {
    const { h, mine, theirs, base, post, app, coder, ana } = await twoTeams();
    const email = await post(`/users/${encodeURIComponent(ana.id)}/send`, {
      to: [app.id, coder.id],
      subject: "Both of you",
      text: "Hello",
    });
    await h.app.settled();

    const [toMine] = mine.received;
    const [toTheirs] = theirs.received;
    if (!toMine || !toTheirs) throw new Error("A team got nothing");
    expect(toMine.headers["svix-id"]).not.toBe(toTheirs.headers["svix-id"]);
    expect(verifies(toMine, app.webhookSecret)).toBe(true);
    expect(verifies(toTheirs, coder.webhookSecret)).toBe(true);
    expect(verifies(toMine, coder.webhookSecret)).toBe(false);
    expect(verifies(toTheirs, app.webhookSecret)).toBe(false);
    // Each delivery says which app it went to; the email's own is my-agent's, coder's is asked for by app.
    expect(email.delivery).toMatchObject({ app: "my-agent", type: "email.received" });
    const forCoder = (await h.call("GET", `${base}/emails/${email.id}/delivery-for?app=${coder.id}`)).body;
    expect(forCoder).toMatchObject({ app: "coder", type: "email.received", id: toTheirs.headers["svix-id"] });
    const deliveries = (await h.call("GET", `${base}/deliveries`)).body as { app: string }[];
    expect(deliveries.map((one) => one.app).sort()).toEqual(["coder", "my-agent"]);
  });

  test("a scripted app sends and replies through its own team's API, headers and all; never as my-agent", async () => {
    const { h, mine, theirs, post, get, app, coder, ana } = await twoTeams();
    const said = await post(`/apps/${coder.id}/send`, {
      to: [app.id],
      cc: [ana.id],
      subject: "Status",
      text: "Deployed.",
      headers: { "Auto-Submitted": "auto-generated" },
    });
    await h.app.settled();
    expect(said.author).toMatchObject({ kind: "app", name: "coder", id: coder.id });
    expect(said.headers).toMatchObject({ "auto-submitted": "auto-generated" });
    expect(said.delivery).toMatchObject({ app: "my-agent", type: "email.received" });
    expect(events(theirs).map((one) => one.type)).toEqual(["email.sent", "email.delivered"]);
    expect(events(mine).map((one) => one.type)).toEqual(["email.received"]);

    const asked = await post(`/users/${encodeURIComponent(ana.id)}/send`, {
      to: [coder.id],
      subject: "Question",
      text: "Is it done?",
    });
    const replied = await post(`/apps/${coder.id}/reply`, { email: asked.id, text: "Yes." });
    expect(replied).toMatchObject({ subject: "Re: Question", to: [ana.address], thread: { id: asked.thread.id } });
    expect(replied.author).toMatchObject({ kind: "app", name: "coder" });
    const inbox = await get(`/users/${encodeURIComponent(ana.id)}/inbox`);
    expect(inbox.map((one: { id: string }) => one.id)).toContain(replied.id);
    expect(await refusal(post(`/apps/${app.id}/send`, { to: [ana.id], subject: "x", text: "x" }))).toBe(
      "invalid_argument",
    );
    expect(await refusal(post("/apps/nobody/send", { to: [ana.id], subject: "x", text: "x" }))).toBe("not_found");
  });

  test("a person and an app can't share a name", async () => {
    const { post } = await twoTeams();
    expect(await refusal(post("/users", { name: "coder" }))).toBe("invalid_argument");
    await post("/users", { name: "Reviewer" });
    expect(await refusal(post("/apps", { name: "reviewer" }))).toBe("invalid_argument");
  });

  test("exit check 12.5: channelstack env --app prints the team's lines under my-agent's keys", async () => {
    const { h, coder } = await twoTeams();
    expect((await h.call("GET", "/env?app=coder&channel=resend")).body).toMatchObject({
      RESEND_API_KEY: coder.apiKey,
      RESEND_WEBHOOK_SECRET: coder.webhookSecret,
      RESEND_FROM: `coder <${coder.address}>`,
    });
    expect((await h.call("GET", "/env?channel=resend")).body.RESEND_API_KEY).toBe(h.secrets.get("resend", "apiKey"));
    // A team no test made yet is made by asking for its lines, so its agent can start first.
    expect((await h.call("GET", "/env?app=support&channel=resend")).body).toMatchObject({
      RESEND_API_KEY: h.secrets.forApp("resend", "support", "apiKey"),
      RESEND_FROM: "support <support@support.acme.example>",
    });
  });
});
