import { createPublicKey, createVerify, X509Certificate } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { harness, type RecordingAgent, recordingAgent } from "../../../test/app-harness.ts";
import { googlePushProblems, googleResponseProblems } from "../../../test/schemas/google.ts";
import { PUBSUB } from "./fake/world.ts";

/**
 * The Google fake's API as an agent meets it: Google's token endpoint and its refusals, Gmail's
 * refusals, and every answer and push held to Gmail's discovery document and Pub/Sub's push format
 * (exit check 9.2).
 */
let agent: RecordingAgent | undefined;
afterEach(() => agent?.close());

const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function mailbox() {
  agent = await recordingAgent();
  agent.respond = () => ({ status: 204 });
  const h = harness({ google: agent.url });
  const secret = (name: string) => h.secrets.get("google", name);
  const grant = (fields: Record<string, string>) =>
    h.provider("POST", "google/token", new URLSearchParams(fields).toString(), null, FORM);
  const { body: issued } = await grant({
    grant_type: "refresh_token",
    client_id: secret("clientId"),
    client_secret: secret("clientSecret"),
    refresh_token: secret("refreshToken"),
  });
  /** A Gmail call as the agent's client makes it, its answer held to the discovery document. */
  const gmail = async (method: string, path: string, body?: unknown, token: string | null = issued.access_token) => {
    const reply = await h.provider(method, `google/gmail/v1/users/me${path}`, body, token);
    const route = `/gmail/v1/users/me${path.split("?")[0]}`;
    expect(googleResponseProblems(method, route, reply.status, reply.body)).toEqual([]);
    return reply;
  };
  const { sessionId } = (await h.call("POST", "/sessions")).body;
  const base = `/sessions/${sessionId}/google`;
  const { app } = (await h.call("GET", base)).body;
  const ana = (await h.call("POST", `${base}/users`, { name: "Ana" })).body;
  const send = (subject: string, text = "Where is my refund?") =>
    h
      .call("POST", `${base}/users/${encodeURIComponent(ana.id)}/send`, { to: [app.id], subject, text })
      .then((reply) => reply.body);
  /** The pushes delivered so far, each held to Pub/Sub's push format. */
  const pushes = async () => {
    await h.app.settled();
    const received = (agent as RecordingAgent).received;
    for (const push of received) expect(googlePushProblems(JSON.parse(push.body))).toEqual([]);
    return received;
  };
  const watch = () =>
    gmail("POST", "/watch", { topicName: PUBSUB.topic, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" });
  return { h, secret, grant, issued, gmail, base, app, ana, send, pushes, watch };
}

describe("Google's token endpoint, for the refresh-token grant only", () => {
  test("a fresh access token for an hour, and Google's refusals", async () => {
    const { issued, grant, secret } = await mailbox();
    expect(issued).toEqual({
      access_token: expect.stringMatching(/^ya29\./),
      expires_in: 3599,
      scope: "https://www.googleapis.com/auth/gmail.modify",
      token_type: "Bearer",
    });
    const client = { client_id: secret("clientId"), client_secret: secret("clientSecret") };
    expect(await grant({ grant_type: "authorization_code", ...client })).toMatchObject({
      status: 400,
      body: { error: "unsupported_grant_type", error_description: "Invalid grant_type: authorization_code" },
    });
    expect(
      await grant({ grant_type: "refresh_token", client_id: "nope", client_secret: "nope", refresh_token: "x" }),
    ).toMatchObject({
      status: 401,
      body: { error: "invalid_client" },
    });
    expect(await grant({ grant_type: "refresh_token", ...client })).toMatchObject({
      status: 400,
      body: { error: "invalid_request", error_description: "Missing required parameter: refresh_token" },
    });
    expect(await grant({ grant_type: "refresh_token", ...client, refresh_token: "1//0wrong" })).toMatchObject({
      status: 400,
      body: { error: "invalid_grant" },
    });
  });
});

describe("what Gmail refuses, as Gmail does", () => {
  test("no token, a wrong one, another mailbox", async () => {
    const { h, gmail, issued } = await mailbox();
    const none = await gmail("GET", "/profile", undefined, null);
    expect(none).toMatchObject({
      status: 401,
      body: { error: { status: "UNAUTHENTICATED", errors: [{ reason: "required" }] } },
    });
    const wrong = await gmail("GET", "/profile", undefined, "ya29.not-one-the-fake-handed-out");
    expect(wrong).toMatchObject({ status: 401, body: { error: { errors: [{ reason: "authError" }] } } });
    const other = await h.provider(
      "GET",
      "google/gmail/v1/users/ben@example.com/profile",
      undefined,
      issued.access_token,
    );
    expect(other.status).toBe(403);
  });

  test("an unknown or malformed id, a form body, a watch on a topic Gmail can't publish to, a send to no one", async () => {
    const { h, issued, gmail } = await mailbox();
    // A form is no JSON to Gmail: only the token endpoint takes one.
    const form = await h.provider("POST", "google/gmail/v1/users/me/labels", "name=Refunds", issued.access_token, FORM);
    expect(form).toMatchObject({ status: 400, body: { error: { message: "Invalid JSON payload received." } } });
    expect((await gmail("GET", "/messages/19aaaaaaaaaaaaaa")).body.error).toMatchObject({
      code: 404,
      status: "NOT_FOUND",
    });
    expect((await gmail("GET", "/messages/not-an-id")).body.error).toMatchObject({
      code: 400,
      message: "Invalid id value",
    });
    const watch = await gmail("POST", "/watch", { topicName: "projects/elsewhere/topics/gmail" });
    expect(watch).toMatchObject({ status: 403, body: { error: { status: "PERMISSION_DENIED" } } });
    const raw = Buffer.from("From: my-agent <my-agent@acme.example>\r\nSubject: Hi\r\n\r\nhello").toString("base64url");
    expect((await gmail("POST", "/messages/send", { raw })).status).toBe(400);
    expect((await gmail("POST", "/messages/send", { raw, threadId: "19aaaaaaaaaaaaaa" })).status).toBe(404);
    expect((await gmail("GET", "/history?startHistoryId=1")).status).toBe(404);
  });
});

describe("the mailbox, as Gmail's discovery document describes it", () => {
  test("an email to the agent: listed, read in every format, its history, labelled and answered in its thread", async () => {
    const { gmail, send, watch } = await mailbox();
    const { body: watched } = await watch();
    const email = await send("Refund");

    const { body: list } = await gmail("GET", "/messages?labelIds=INBOX&q=is:unread%20from:ana");
    expect(list.messages).toHaveLength(1);
    const [{ id, threadId }] = list.messages;
    for (const format of ["full", "metadata", "minimal", "raw"]) await gmail("GET", `/messages/${id}?format=${format}`);
    const { body: full } = await gmail("GET", `/messages/${id}?format=full`);
    expect(full.labelIds).toEqual(["UNREAD", "CATEGORY_PERSONAL", "INBOX"]);
    expect(full.payload.headers).toContainEqual({ name: "Subject", value: "Refund" });
    expect(Buffer.from(full.payload.body.data, "base64url").toString("utf8")).toBe("Where is my refund?");
    const { body: raw } = await gmail("GET", `/messages/${id}?format=raw`);
    expect(Buffer.from(raw.raw, "base64url").toString("utf8")).toContain(`Message-ID: ${email.messageId}`);

    const { body: history } = await gmail(
      "GET",
      `/history?startHistoryId=${watched.historyId}&historyTypes=messageAdded`,
    );
    expect(history.history[0].messagesAdded[0].message).toMatchObject({ id, threadId });

    await gmail("POST", `/messages/${id}/modify`, { removeLabelIds: ["UNREAD"] });
    const answer = [
      "From: my-agent <my-agent@acme.example>",
      "To: ana@example.com",
      "Subject: Re: Refund",
      `In-Reply-To: ${email.messageId}`,
      `References: ${email.messageId}`,
      "",
      "Your refund was sent.",
    ].join("\r\n");
    const { body: sent } = await gmail("POST", "/messages/send", {
      raw: Buffer.from(answer).toString("base64url"),
      threadId,
    });
    expect(sent).toMatchObject({ threadId, labelIds: ["SENT"] });
    const { body: thread } = await gmail("GET", `/threads/${threadId}`);
    expect(thread.messages.map((message: { id: string }) => message.id)).toEqual([id, sent.id]);
    await gmail("GET", "/threads");
    await gmail("GET", "/profile");
    await gmail("GET", "/labels");
    await gmail("GET", "/labels/INBOX");
    await gmail("POST", "/labels", { name: "channelstack-run-unit" });
    expect((await gmail("POST", "/labels", { name: "channelstack-run-unit" })).status).toBe(409);
    expect((await gmail("POST", "/stop")).status).toBe(204);
  });

  test("search as Gmail reads it, spam listed only when asked for; a thread's history id the same listed and read", async () => {
    const { gmail, send } = await mailbox();
    const email = await send("Refund");
    await send("Other");
    const ids = async (q: string) =>
      ((await gmail("GET", `/messages?q=${encodeURIComponent(q)}`)).body.messages ?? []).map(
        (message: { id: string }) => message.id,
      );
    const [other, refund] = await ids("in:inbox");
    // Dates, categories and OR, as Gmail's search reads them.
    expect(await ids("newer_than:1d")).toEqual([other, refund]);
    expect(await ids("older_than:1d")).toEqual([]);
    expect(await ids("category:primary")).toEqual([other, refund]);
    expect(await ids("subject:Refund OR subject:Other")).toEqual([other, refund]);
    expect(await ids("subject:Refund OR subject:Nothing")).toEqual([refund]);
    expect(await ids("has:attachment")).toEqual([]);
    await gmail("POST", `/messages/${other}/modify`, { addLabelIds: ["SPAM"] });
    expect(await ids("-in:trash")).toEqual([refund]);
    expect(await ids("in:spam")).toContain(other);
    // Listing by the spam label lists spam, as Gmail does.
    const { body: spam } = await gmail("GET", "/messages?labelIds=SPAM");
    expect(spam.messages.map((message: { id: string }) => message.id)).toEqual([other]);

    // The agent answers in the thread, then marks the older message read: the thread's history moves on.
    const { body: inbox } = await gmail("GET", `/messages/${refund}?format=minimal`);
    const answer = `From: my-agent <my-agent@acme.example>\r\nTo: ana@example.com\r\nSubject: Re: Refund\r\nIn-Reply-To: ${email.messageId}\r\n\r\nSent.`;
    await gmail("POST", "/messages/send", { raw: Buffer.from(answer).toString("base64url"), threadId: inbox.threadId });
    await gmail("POST", `/messages/${refund}/modify`, { removeLabelIds: ["UNREAD"] });
    const { body: read } = await gmail("GET", `/threads/${inbox.threadId}`);
    const { body: listed } = await gmail("GET", "/threads");
    const fromList = listed.threads.find((thread: { id: string }) => thread.id === inbox.threadId);
    expect(fromList.historyId).toBe(read.historyId);
  });

  test("the agent's labels: renamed, replaced, deleted and taken off its mail; Gmail's own refused", async () => {
    const { gmail, send } = await mailbox();
    await send("Refund");
    const { body: list } = await gmail("GET", "/messages");
    const [message] = list.messages;
    const { body: made } = await gmail("POST", "/labels", { name: "Todo" });
    await gmail("POST", "/labels", { name: "Done" });
    await gmail("POST", `/messages/${message.id}/modify`, { addLabelIds: [made.id] });
    const { body: patched } = await gmail("PATCH", `/labels/${made.id}`, { labelListVisibility: "labelHide" });
    expect(patched).toMatchObject({ id: made.id, name: "Todo", labelListVisibility: "labelHide" });
    expect((await gmail("PUT", `/labels/${made.id}`, { name: "Done" })).status).toBe(409);
    expect((await gmail("PUT", `/labels/${made.id}`, { name: "Doing" })).body.name).toBe("Doing");
    expect((await gmail("DELETE", "/labels/INBOX")).status).toBe(400);
    expect((await gmail("PATCH", "/labels/INBOX", { name: "Mine" })).status).toBe(400);
    expect((await gmail("DELETE", `/labels/${made.id}`)).status).toBe(204);
    expect((await gmail("GET", `/labels/${made.id}`)).status).toBe(404);
    const { body: after } = await gmail("GET", `/messages/${message.id}?format=minimal`);
    expect(after.labelIds).not.toContain(made.id);
  });

  test("an answer sent without a threadId starts a thread of its own, though it names the email", async () => {
    const { gmail, send } = await mailbox();
    const email = await send("Refund");
    const { body: list } = await gmail("GET", "/messages");
    const answer = `From: my-agent <my-agent@acme.example>\r\nTo: ana@example.com\r\nSubject: Re: Refund\r\nIn-Reply-To: ${email.messageId}\r\nReferences: ${email.messageId}\r\n\r\nSent.`;
    const { body: sent } = await gmail("POST", "/messages/send", { raw: Buffer.from(answer).toString("base64url") });
    expect(sent.threadId).not.toBe(list.messages[0].threadId);
  });

  test("an answer whose subject doesn't match starts a thread of its own in the mailbox, as Gmail threads", async () => {
    const { gmail, send } = await mailbox();
    const email = await send("Refund");
    const { body: list } = await gmail("GET", "/messages");
    const answer = `From: my-agent <my-agent@acme.example>\r\nTo: ana@example.com\r\nSubject: Something else\r\nIn-Reply-To: ${email.messageId}\r\n\r\nhi`;
    const { body: sent } = await gmail("POST", "/messages/send", {
      raw: Buffer.from(answer).toString("base64url"),
      threadId: list.messages[0].threadId,
    });
    expect(sent.threadId).not.toBe(list.messages[0].threadId);
  });
});

describe("what the agent sends, as Gmail keeps and sends it", () => {
  test("Gmail's own Message-ID and From, in every format and in what the recipient gets", async () => {
    const { h, gmail, base, ana, pushes } = await mailbox();
    // A watch on every label: the agent hears of its own sent mail too.
    await gmail("POST", "/watch", { topicName: PUBSUB.topic });
    const written = [
      "From: Someone Else <someone@elsewhere.example>",
      `To: =?UTF-8?Q?Lima=2C_Ana?= <${ana.address}>`,
      "Subject: Hello",
      "",
      "Hi Ana.",
    ].join("\r\n");
    const { body: sent } = await gmail("POST", "/messages/send", { raw: Buffer.from(written).toString("base64url") });
    const { body: raw } = await gmail("GET", `/messages/${sent.id}?format=raw`);
    const text = Buffer.from(raw.raw, "base64url").toString("utf8");
    expect(text).toMatch(/^Message-ID: <CA[\w+=-]+@mail\.gmail\.com>\r\n/m);
    expect(text).toContain("From: my-agent <my-agent@acme.example>\r\n");
    expect(text).not.toContain("someone@elsewhere.example");
    expect(text).toContain("Hi Ana.");
    const { body: full } = await gmail("GET", `/messages/${sent.id}?format=metadata`);
    const header = (name: string) =>
      full.payload.headers.find((each: { name: string }) => each.name.toLowerCase() === name)?.value;
    const [mailed] = (await h.call("GET", `${base}/users/${encodeURIComponent(ana.id)}/inbox`)).body;
    expect(header("message-id")).toBe(mailed.messageId);
    expect(header("from")).toBe("my-agent <my-agent@acme.example>");
    expect(mailed.to).toEqual([ana.address]);
    // It was pushed, but it is no email to the agent: no delivery told the agent of it.
    expect(await pushes()).toHaveLength(1);
    expect(mailed.delivery).toBeUndefined();
  });
});

describe("pushes, as Pub/Sub sends Gmail's", () => {
  test("none without a watch; then at most one a second, the held one with the newest history id", async () => {
    const { h, send, pushes, watch } = await mailbox();
    await send("Before the watch");
    expect(await pushes()).toHaveLength(0);
    await watch();
    const first = await send("First");
    const second = await send("Second");
    expect(first.delivery).toBeDefined();
    expect(second.delivery).toBeUndefined();
    expect(await pushes()).toHaveLength(1);
    h.timers.advance(1_000);
    const all = await pushes();
    expect(all).toHaveLength(2);
    const historyIds = all.map(
      (push) => JSON.parse(Buffer.from(JSON.parse(push.body).message.data, "base64").toString()).historyId,
    );
    expect(BigInt(historyIds[1])).toBeGreaterThan(BigInt(historyIds[0]));
  });

  test("a reset keeps the agent's watch and labels, and the mailbox's history ids growing", async () => {
    const { h, gmail, send, pushes, watch } = await mailbox();
    await watch();
    expect((await gmail("POST", "/labels", { name: "Processed" })).body.id).toBe("Label_1");
    await send("Before the reset");
    const historyOf = (push: { body: string } | undefined) =>
      BigInt(JSON.parse(Buffer.from(JSON.parse(push?.body ?? "{}").message.data, "base64").toString()).historyId);
    const before = historyOf((await pushes()).at(-1));

    await h.call("POST", "/reset");
    const { sessionId } = (await h.call("POST", "/sessions")).body;
    const base = `/sessions/${sessionId}/google`;
    const { app } = (await h.call("GET", base)).body;
    const ben = (await h.call("POST", `${base}/users`, { name: "Ben" })).body;
    await h.call("POST", `${base}/users/${encodeURIComponent(ben.id)}/send`, {
      to: [app.id],
      subject: "After",
      text: "Hi",
    });
    const after = historyOf((await pushes()).at(-1));
    expect(after).toBeGreaterThan(before);
    // The agent's cursor from before the reset lists the new mail.
    const { body: listed } = await gmail("GET", `/history?startHistoryId=${before}&historyTypes=messageAdded`);
    expect(listed.history).toHaveLength(1);
    // A label the agent made before it is still there, and a new one gets an id of its own.
    expect((await gmail("GET", "/labels/Label_1")).body.name).toBe("Processed");
    expect((await gmail("POST", "/labels", { name: "Answered" })).body.id).toBe("Label_2");
  });

  test("its token verifies against the certificate and the JWK the fake serves", async () => {
    const { h, send, pushes, watch } = await mailbox();
    await watch();
    await send("Signed");
    const [push] = await pushes();
    const token = String(push?.headers.authorization).replace(/^Bearer /, "");
    const [header = "", payload = "", signature = ""] = token.split(".");
    const { kid } = JSON.parse(Buffer.from(header, "base64url").toString());
    const { body: pem } = await h.provider("GET", "google/oauth2/v1/certs", undefined, null);
    const certificate = new X509Certificate(pem[kid]);
    expect(certificate.subject).toContain("federated-signon.system.gserviceaccount.com");
    const signed = (key: Parameters<ReturnType<typeof createVerify>["verify"]>[0]) =>
      createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(key, Buffer.from(signature, "base64url"));
    expect(signed(certificate.publicKey)).toBe(true);
    const { body: jwks } = await h.provider("GET", "google/oauth2/v3/certs", undefined, null);
    const [jwk] = jwks.keys;
    expect(jwk).toMatchObject({ kid, kty: "RSA", alg: "RS256", use: "sig" });
    expect(signed(createPublicKey({ key: jwk, format: "jwk" }))).toBe(true);
  });

  test("a forgery for another audience combines with the other forgeries, and comes with Pub/Sub's user agent", async () => {
    const { h, base, send, pushes, watch } = await mailbox();
    await watch();
    const email = await send("Forged");
    await pushes();
    const resent = await h.call("POST", `${base}/deliveries/${email.delivery.id}/resend`, {
      wrongAudience: true,
      stale: true,
    });
    expect(resent.body.forgedSignature).toBe(true);
    const [normal, forged] = await pushes();
    expect(forged?.headers["user-agent"]).toBe(normal?.headers["user-agent"]);
    const claims = (push: typeof normal) =>
      JSON.parse(Buffer.from(String(push?.headers.authorization).split(".")[1] ?? "", "base64url").toString()) as {
        aud: string;
        exp: number;
      };
    expect(claims(forged).aud).not.toBe(claims(normal).aud);
    // Stale too: it had expired before the push that was sent first was signed.
    expect(claims(forged).exp).toBeLessThan(claims(normal).exp - 3600);
  });
});
