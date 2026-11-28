/**
 * Exit check 12.3 for Google: several apps (decision 0027), each a Gmail mailbox of its own at
 * `<name>@acme.example`, with its own OAuth client and refresh token, its own watch and push
 * endpoint, which is its push tokens' audience. One app's email to another lands in the other's
 * mailbox and its watch pushes; the sender's own history (SENT) pushes to the sender's endpoint.
 * Each token answers as its mailbox, and the headers an agent sets are kept.
 */
import { OAuth2Client } from "google-auth-library";
import { afterEach, describe, expect, test } from "vitest";

import { harness, type RecordingAgent, recordingAgent, refusal } from "../../../test/app-harness.ts";
import { googlePushProblems, googleResponseProblems } from "../../../test/schemas/google.ts";
import { LOOP_LIMIT } from "../../core/loops/index.ts";
import { PUBSUB, pubsubOf } from "./fake/world.ts";

const agents: RecordingAgent[] = [];
afterEach(() => {
  for (const agent of agents.splice(0)) agent.close();
});

const FORM = { "content-type": "application/x-www-form-urlencoded" };

/** A world with my-agent's mailbox pushing to one endpoint and `coder`'s to another. */
async function twoMailboxes() {
  const mine = await recordingAgent();
  const theirs = await recordingAgent();
  for (const agent of [mine, theirs]) agent.respond = () => ({ status: 204 });
  agents.push(mine, theirs);
  const h = harness(
    { google: mine.url },
    { appWebhooks: (driver, app) => (driver === "google" && app === "coder" ? theirs.url : undefined) },
  );
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/google`;
  const post = async (path: string, body?: unknown) => {
    const response = await h.call("POST", `${base}${path}`, body);
    if (response.status >= 400) throw Object.assign(new Error(response.body.error), response);
    return response.body;
  };
  const get = async (path: string) => (await h.call("GET", `${base}${path}`)).body;
  const app = (await get("")).app;
  const coder = await post("/apps", { name: "coder" });
  const grant = (fields: Record<string, string>) =>
    h.provider("POST", "google/token", new URLSearchParams(fields).toString(), null, FORM);
  /** An access token for an app's mailbox, from its own OAuth client and refresh token. */
  const tokenOf = async (handle: { clientId: string; clientSecret: string; refreshToken: string }) =>
    (
      await grant({
        grant_type: "refresh_token",
        client_id: handle.clientId,
        client_secret: handle.clientSecret,
        refresh_token: handle.refreshToken,
      })
    ).body.access_token as string;
  /** A Gmail call as an app's client makes it, its answer held to the discovery document. */
  const gmail = async (token: string, method: string, path: string, body?: unknown, user = "me") => {
    const reply = await h.provider(method, `google/gmail/v1/users/${user}${path}`, body, token);
    expect(googleResponseProblems(method, `/gmail/v1/users/me${path.split("?")[0]}`, reply.status, reply.body)).toEqual(
      [],
    );
    return reply;
  };
  const mineToken = await tokenOf(app);
  const coderToken = await tokenOf(coder);
  const ana = await post("/users", { name: "Ana" });
  /** The pushes an endpoint got, each held to Pub/Sub's push format, and Gmail's notification in it. */
  const pushes = async (agent: RecordingAgent) => {
    await h.app.settled();
    return agent.received.map((push) => {
      const body = JSON.parse(push.body);
      expect(googlePushProblems(body)).toEqual([]);
      return {
        ...push,
        body,
        notification: JSON.parse(Buffer.from(body.message.data, "base64").toString()) as {
          emailAddress: string;
          historyId: string;
        },
      };
    });
  };
  return {
    h,
    sessionId: sessionId as string,
    mine,
    theirs,
    base,
    post,
    get,
    app,
    coder,
    tokenOf,
    grant,
    gmail,
    mineToken,
    coderToken,
    ana,
    pushes,
  };
}

/** A message as an agent's client writes it for `users.messages.send`. */
const raw = (lines: string[]) => Buffer.from(lines.join("\r\n")).toString("base64url");

describe("exit check 12.3: Google apps", () => {
  test("an app is a mailbox of its own: its own address, OAuth client and refresh token; the same name gives the same mailbox", async () => {
    const { h, post, get, app, coder } = await twoMailboxes();
    expect(coder).toMatchObject({ name: "coder", kind: "app", channel: "google", address: "coder@acme.example" });
    expect(coder.id).toMatch(/^1\d{20}$/);
    expect(coder.clientId).toBe(h.secrets.forApp("google", "coder", "clientId"));
    expect(coder.refreshToken).toBe(h.secrets.forApp("google", "coder", "refreshToken"));
    for (const key of ["id", "address", "clientId", "clientSecret", "refreshToken"]) {
      expect(coder[key]).not.toBe(app[key]);
    }
    expect(app.clientId).toBe(h.secrets.get("google", "clientId"));
    expect(await post("/apps", { name: "coder" })).toEqual(coder);
    expect((await get("/apps")).map((one: { name: string }) => one.name)).toEqual(["my-agent", "coder"]);
    expect(await refusal(post("/apps", { name: "my-agent" }))).toBe("invalid_argument");
    expect(await refusal(post("/apps", { name: "Coder" }))).toBe("invalid_argument");
  });

  test("each token answers as its own mailbox; one app's client can't refresh another's token", async () => {
    const { grant, gmail, app, coder, coderToken, mineToken } = await twoMailboxes();
    expect((await gmail(coderToken, "GET", "/profile")).body.emailAddress).toBe("coder@acme.example");
    expect((await gmail(mineToken, "GET", "/profile")).body.emailAddress).toBe("my-agent@acme.example");
    const crossed = await grant({
      grant_type: "refresh_token",
      client_id: coder.clientId,
      client_secret: coder.clientSecret,
      refresh_token: app.refreshToken,
    });
    expect(crossed).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    // Another mailbox, by its address, is delegation it doesn't have.
    const other = await gmail(coderToken, "GET", "/profile", undefined, encodeURIComponent(app.address));
    expect(other).toMatchObject({ status: 403, body: { error: { status: "PERMISSION_DENIED" } } });
    // Each mailbox watches with its own topic.
    expect((await gmail(coderToken, "POST", "/watch", { topicName: PUBSUB.topic })).status).toBe(403);
    expect((await gmail(coderToken, "POST", "/watch", { topicName: pubsubOf("coder").topic })).status).toBe(200);
  });

  test("a person's email to an app lands in its mailbox alone, and its watch pushes to its own endpoint", async () => {
    const { mine, theirs, post, gmail, coder, coderToken, mineToken, ana, pushes } = await twoMailboxes();
    await gmail(mineToken, "POST", "/watch", { topicName: PUBSUB.topic, labelIds: ["INBOX"] });
    await gmail(coderToken, "POST", "/watch", { topicName: pubsubOf("coder").topic, labelIds: ["INBOX"] });

    const email = await post(`/users/${encodeURIComponent(ana.id)}/send`, {
      to: [coder.id],
      subject: "Build",
      text: "It's red",
    });

    const [push] = await pushes(theirs);
    expect(push?.notification.emailAddress).toBe(coder.address);
    expect(push?.body.subscription).toBe(pubsubOf("coder").subscription);
    expect(await pushes(mine)).toEqual([]);
    expect(email.delivery).toBeUndefined();
    const listed = (await gmail(coderToken, "GET", "/messages")).body.messages;
    expect(listed).toHaveLength(1);
    expect((await gmail(mineToken, "GET", "/messages")).body.messages).toBeUndefined();
    // A message of one mailbox isn't found from another.
    expect((await gmail(mineToken, "GET", `/messages/${listed[0].id}`)).status).toBe(404);
  });

  test("one app's email to another lands in the other's mailbox and pushes there; the sender's SENT change pushes to the sender", async () => {
    const { h, mine, theirs, post, get, gmail, app, coder, coderToken, mineToken, ana, pushes } = await twoMailboxes();
    await gmail(mineToken, "POST", "/watch", { topicName: PUBSUB.topic, labelIds: ["INBOX"] });
    // coder's watch takes every change: its own sent mail too, the loop of one agent the decision warns of.
    await gmail(coderToken, "POST", "/watch", { topicName: pubsubOf("coder").topic });
    const asked = await post(`/users/${encodeURIComponent(ana.id)}/send`, {
      to: [coder.id],
      subject: "Refund",
      text: "Where is it?",
    });
    const [copy] = (await gmail(coderToken, "GET", "/messages")).body.messages;

    // coder hands off to my-agent in the thread, marking its message automatic.
    const sent = await gmail(coderToken, "POST", "/messages/send", {
      threadId: copy.threadId,
      raw: raw([
        `From: coder <${coder.address}>`,
        `To: ${app.address}`,
        "Subject: Re: Refund",
        `In-Reply-To: ${asked.messageId}`,
        `References: ${asked.messageId}`,
        "Auto-Submitted: auto-replied",
        "",
        "my-agent: yours.",
      ]),
    });
    expect(sent.body).toMatchObject({ threadId: copy.threadId, labelIds: ["SENT"] });
    h.timers.advance(1000);

    const [toMine] = await pushes(mine);
    expect(toMine?.notification.emailAddress).toBe(app.address);
    const inbox = (await gmail(mineToken, "GET", "/messages?labelIds=INBOX")).body.messages;
    expect(inbox).toHaveLength(1);
    const arrived = await gmail(mineToken, "GET", `/messages/${inbox[0].id}?format=metadata`);
    expect(arrived.body.payload.headers).toEqual(
      expect.arrayContaining([{ name: "Auto-Submitted", value: "auto-replied" }]),
    );
    // coder heard Ana's email, then its own SENT change: both at its own endpoint.
    const coderPushes = await pushes(theirs);
    expect(coderPushes).toHaveLength(2);
    expect(coderPushes.every((push) => push.notification.emailAddress === coder.address)).toBe(true);

    const thread = await get(`/threads/${asked.thread.id}/messages`);
    expect(thread.map((one: { author: { name: string } }) => one.author.name)).toEqual(["Ana", "coder"]);
    expect(thread[1].headers["auto-submitted"]).toBe("auto-replied");
    expect(thread[1].delivery).toMatchObject({ app: "my-agent", type: "gmail.history" });
  });

  test("A1: an email two mailboxes get is two pushes, each to its own endpoint, which verifyIdToken accepts for its own audience only", async () => {
    const { h, mine, theirs, base, post, gmail, app, coder, coderToken, mineToken, ana, pushes } = await twoMailboxes();
    await gmail(mineToken, "POST", "/watch", { topicName: PUBSUB.topic, labelIds: ["INBOX"] });
    await gmail(coderToken, "POST", "/watch", { topicName: pubsubOf("coder").topic, labelIds: ["INBOX"] });
    const email = await post(`/users/${encodeURIComponent(ana.id)}/send`, {
      to: [app.id, coder.id],
      subject: "Both of you",
      text: "Hello",
    });
    const [toMine] = await pushes(mine);
    const [toTheirs] = await pushes(theirs);
    if (!toMine || !toTheirs) throw new Error("A mailbox wasn't told");
    expect(toMine.body.message.messageId).not.toBe(toTheirs.body.message.messageId);

    // The receiver as Google's guide has it, against the fake's certificates.
    const certs = (await h.provider("GET", "google/oauth2/v1/certs")).body as Record<string, string>;
    const auth = new OAuth2Client();
    Object.assign(auth, { getFederatedSignonCertsAsync: async () => ({ certs, format: "PEM" }) });
    const accepts = async (push: typeof toMine, audience: string) => {
      const idToken = String(push.headers.authorization).replace(/^Bearer /, "");
      try {
        const ticket = await auth.verifyIdToken({ idToken, audience });
        return ticket.getPayload()?.email === PUBSUB.serviceAccount;
      } catch {
        return false;
      }
    };
    expect(await accepts(toMine, mine.url)).toBe(true);
    expect(await accepts(toTheirs, theirs.url)).toBe(true);
    expect(await accepts(toMine, theirs.url)).toBe(false);
    expect(await accepts(toTheirs, mine.url)).toBe(false);

    expect(email.delivery).toMatchObject({ app: "my-agent", id: toMine.body.message.messageId });
    const forCoder = (await h.call("GET", `${base}/emails/${email.id}/delivery-for?app=coder`)).body;
    expect(forCoder).toMatchObject({ app: "coder", emailAddress: coder.address, id: toTheirs.body.message.messageId });
  });

  test("a scripted app sends and replies through its own mailbox's API, headers and all; never as my-agent", async () => {
    const { mine, post, get, gmail, app, coder, coderToken, mineToken, ana, pushes } = await twoMailboxes();
    await gmail(mineToken, "POST", "/watch", { topicName: PUBSUB.topic, labelIds: ["INBOX"] });
    const said = await post(`/apps/${coder.id}/send`, {
      to: [app.id],
      cc: [ana.id],
      subject: "Status",
      text: "Deployed.",
      headers: { "Auto-Submitted": "auto-generated" },
    });
    expect(said.author).toMatchObject({ kind: "app", name: "coder", id: coder.id });
    expect(said.headers).toMatchObject({ "auto-submitted": "auto-generated" });
    expect(said.delivery).toMatchObject({ app: "my-agent" });
    expect((await pushes(mine)).map((push) => push.notification.emailAddress)).toEqual([app.address]);
    // It went through coder's own mailbox: its sent copy is there.
    expect((await gmail(coderToken, "GET", `/messages/${said.id}`)).body.labelIds).toEqual(["SENT"]);

    const asked = await post(`/users/${encodeURIComponent(ana.id)}/send`, {
      to: [coder.id],
      subject: "Question",
      text: "Is it done?",
    });
    const replied = await post(`/apps/${coder.id}/reply`, { email: asked.id, text: "Yes." });
    expect(replied).toMatchObject({ subject: "Re: Question", to: [ana.address], thread: { id: asked.thread.id } });
    // In coder's mailbox, the reply joins the thread Ana's email is in.
    const [copy] = (await gmail(coderToken, "GET", "/messages?labelIds=INBOX")).body.messages;
    expect((await gmail(coderToken, "GET", `/messages/${replied.id}`)).body.threadId).toBe(copy.threadId);
    const inbox = await get(`/users/${encodeURIComponent(ana.id)}/inbox`);
    expect(inbox.map((one: { id: string }) => one.id)).toContain(replied.id);
    expect(await refusal(post(`/apps/${app.id}/send`, { to: [ana.id], subject: "x", text: "x" }))).toBe(
      "invalid_argument",
    );
  });

  test("exit check 12.6: an app answering its own answers is stopped at the guard's limit, its SENT pushes too, and the session says so", async () => {
    const { h, sessionId, theirs, post, coder, coderToken, gmail, ana, pushes } = await twoMailboxes();
    // coder's watch takes every change, its own sent mail too: the loop of one agent.
    await gmail(coderToken, "POST", "/watch", { topicName: pubsubOf("coder").topic });
    const asked = await post(`/users/${encodeURIComponent(ana.id)}/send`, {
      to: [coder.id],
      subject: "Loop",
      text: "Answer this",
    });
    let last = asked;
    for (let i = 0; i < LOOP_LIMIT + 5; i++) {
      h.timers.advance(1000);
      last = await post(`/apps/${coder.id}/reply`, { email: asked.id, text: `turn ${i}` });
    }
    h.timers.advance(1000);
    expect(last.thread.id).toBe(asked.thread.id);

    // coder heard Ana's email, then its own SENT change for each answer up to the limit, and nothing after.
    expect(await pushes(theirs)).toHaveLength(1 + LOOP_LIMIT);
    const quiet = (await h.call("GET", `/sessions/${sessionId}/quiet`)).body;
    expect(quiet.loops).toEqual([expect.stringMatching(/^a bot loop in google \S+ was stopped after 50 app messages/)]);
    // A person writing again starts the conversation over.
    h.timers.advance(1000);
    const again = await post(`/users/${encodeURIComponent(ana.id)}/reply`, { email: last.id, text: "Again" });
    expect(again.thread.id).toBe(asked.thread.id);
    h.timers.advance(1000);
    await post(`/apps/${coder.id}/reply`, { email: again.id, text: "back" });
    h.timers.advance(1000);
    expect(await pushes(theirs)).toHaveLength(3 + LOOP_LIMIT);
  });

  test("a person and an app can't share a name", async () => {
    const { post } = await twoMailboxes();
    expect(await refusal(post("/users", { name: "coder" }))).toBe("invalid_argument");
    await post("/users", { name: "Reviewer" });
    expect(await refusal(post("/apps", { name: "reviewer" }))).toBe("invalid_argument");
  });

  test("exit check 12.5: channelstack env --app prints the mailbox's lines under my-agent's keys", async () => {
    const { h, theirs, coder } = await twoMailboxes();
    expect((await h.call("GET", "/env?app=coder&channel=google")).body).toMatchObject({
      GOOGLE_CLIENT_ID: coder.clientId,
      GOOGLE_CLIENT_SECRET: coder.clientSecret,
      GOOGLE_REFRESH_TOKEN: coder.refreshToken,
      GMAIL_ADDRESS: "coder@acme.example",
      GOOGLE_PUBSUB_TOPIC: pubsubOf("coder").topic,
      GOOGLE_PUSH_AUDIENCE: theirs.url,
    });
    expect((await h.call("GET", "/env?channel=google")).body.GOOGLE_PUBSUB_TOPIC).toBe(PUBSUB.topic);
    // A mailbox no test made yet is made by asking for its lines; without an endpoint it has no audience.
    const support = (await h.call("GET", "/env?app=support&channel=google")).body;
    expect(support).toMatchObject({
      GOOGLE_CLIENT_ID: h.secrets.forApp("google", "support", "clientId"),
      GMAIL_ADDRESS: "support@acme.example",
    });
    expect(support).not.toHaveProperty("GOOGLE_PUSH_AUDIENCE");
  });
});
