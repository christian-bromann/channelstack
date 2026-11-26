import { describe, expect, test } from "vitest";

import { harness } from "../../../../test/app-harness.ts";
import { type GoogleStub, googleStub, type Sent } from "../../../../test/google-live-stub.ts";
import { systemTimers } from "../../../core/clock/index.ts";
import { googleMaintenance } from "./maintenance.ts";

/** The environment a live Google run has: the agent's OAuth client and mailbox, and the allowlist. */
const liveEnv = (stub: GoogleStub, allowlist: string) => ({
  CHANNELSTACK_GOOGLE_CLIENT_ID: stub.client.id,
  CHANNELSTACK_GOOGLE_CLIENT_SECRET: stub.client.secret,
  CHANNELSTACK_GOOGLE_REFRESH_TOKEN: stub.agent.refreshToken,
  CHANNELSTACK_LIVE_GOOGLE_ADDRESSES: allowlist,
  CHANNELSTACK_RUN_ID: "unit9",
});

/** A server whose Google driver is live against the stub, as in CI. */
function liveGoogle(stub: GoogleStub, allowlist: string) {
  const server = harness(
    {},
    { live: { env: liveEnv(stub, allowlist), fetch: stub.fetch, apiBase: { google: stub.url } } },
  );
  const open = async () => {
    const { body } = await server.call("POST", "/sessions", {});
    const google = (method: string, path: string, payload?: unknown) =>
      server.call(method, `/sessions/${body.sessionId}/google${path}`, payload);
    return { google, close: () => server.call("DELETE", `/sessions/${body.sessionId}`) };
  };
  return { ...server, open };
}

const AGENT = "my-agent@agent.example.org";
const ANA = "ana@people.example.org";
const BEN = "ben@people.example.org";

describe("exit check 9.7: Gmail live", () => {
  test("the agent's mailbox outside CHANNELSTACK_LIVE_GOOGLE_ADDRESSES is refused before anything is sent", async () => {
    const stub = googleStub();
    const { google } = await liveGoogle(stub, ANA).open();
    expect((await google("GET", "")).body.error).toBe("live_not_allowlisted");
    expect(stub.sent).toEqual([]);
  });

  test("a person whose mailbox is outside the allowlist is refused, and nothing is sent", async () => {
    const stub = googleStub();
    const eve = stub.mailbox("eve", "eve@elsewhere.example");
    const { google } = await liveGoogle(stub, AGENT).open();
    const outsider = await google("POST", "/users", { name: "Eve", token: eve.refreshToken });
    expect(outsider.body.error).toBe("live_not_allowlisted");
    expect(stub.sent).toEqual([]);
  });

  test("a person emails the agent from their own account; its answer is read back in the thread, every thread labelled for the run", async () => {
    const stub = googleStub();
    const ana = stub.mailbox("ana", ANA);
    const { google, close } = await liveGoogle(stub, `${AGENT},${ANA}`).open();
    const { app } = (await google("GET", "")).body;
    expect(app.address).toBe(AGENT);
    const person = (await google("POST", "/users", { name: "Ana", token: ana.refreshToken })).body;
    expect(person.address).toBe(ANA);

    const email = (
      await google("POST", `/users/${encodeURIComponent(person.id)}/send`, {
        to: [app.id],
        subject: "Refund",
        text: "Where is my refund?",
      })
    ).body;
    expect(email.error, email.message).toBeUndefined();
    const [out] = stub.sent;
    expect(out).toMatchObject({ to: [AGENT], subject: "Refund" });
    expect(out?.headers["x-channelstack-run"]).toMatch(/^channelstack-run-unit9/);

    stub.agentReplies(out as Sent, "Your refund was sent today.");
    const replies = (await google("GET", `/threads/${email.thread.id}/replies`)).body;
    expect(replies).toMatchObject([{ author: { name: "my-agent", kind: "app" }, text: "Your refund was sent today." }]);
    // Each email's labels are its copy's in the agent's mailbox, as in the fake: without the run's own.
    const messages = (await google("GET", `/threads/${email.thread.id}/messages`)).body;
    expect(messages.map((message: { labels: string[] }) => message.labels)).toEqual([["INBOX", "UNREAD"], ["SENT"]]);
    // The run's label on Ana's thread and on the agent's copy of it.
    for (const mailbox of [ana, stub.agent]) {
      expect(mailbox.labels.map((label) => label.name)).toEqual([expect.stringMatching(/^channelstack-run-unit9/)]);
    }
    // Pushes are Gmail's to deliver: channelstack's deliveries are the fake's.
    expect((await google("GET", "/deliveries")).body.error).toBe("unsupported_in_live");

    // Closing the session trashes the run's threads, as the mailbox each is in.
    await close();
    expect(ana.trashed).toHaveLength(1);
    expect(stub.agent.trashed).toHaveLength(1);
  });

  test("two people: the agent's answer to both is one email, and each replies in their own mailbox's thread", async () => {
    const stub = googleStub();
    const ana = stub.mailbox("ana", ANA);
    const ben = stub.mailbox("ben", BEN);
    const { google } = await liveGoogle(stub, `${AGENT},${ANA},${BEN}`).open();
    const { app } = (await google("GET", "")).body;
    const asAna = (await google("POST", "/users", { name: "Ana", token: ana.refreshToken })).body;
    const asBen = (await google("POST", "/users", { name: "Ben", token: ben.refreshToken })).body;
    const email = (
      await google("POST", `/users/${encodeURIComponent(asAna.id)}/send`, {
        to: [app.id, asBen.id],
        subject: "Refund",
        text: "Where is our refund?",
      })
    ).body;
    stub.agentReplies(stub.sent[0] as Sent, "It was sent today.", { to: [ANA, BEN] });
    const replies = (await google("GET", `/threads/${email.thread.id}/replies`)).body;
    expect(replies).toHaveLength(1);

    // Ben answers it: Gmail takes the thread id of Ben's own mailbox, and would refuse Ana's.
    const answered = await google("POST", `/users/${encodeURIComponent(asBen.id)}/reply`, {
      email: replies[0].id,
      text: "Thanks!",
    });
    expect(answered.body.error, answered.body.message).toBeUndefined();
    const own = ben.messages.find((message) => message.sent.text === "Thanks!");
    const answer = ben.messages.find((message) => message.sent.text.includes("It was sent today."));
    expect(own?.threadId).toBe(answer?.threadId);
  });

  test("a thread whose labelling fails is on the ledger all the same, and its session trashes it", async () => {
    const stub = googleStub();
    const ana = stub.mailbox("ana", ANA);
    const { google, close } = await liveGoogle(stub, `${AGENT},${ANA}`).open();
    const { app } = (await google("GET", "")).body;
    const person = (await google("POST", "/users", { name: "Ana", token: ana.refreshToken })).body;
    stub.failNext(/\/threads\/[^/]+\/modify$/, 403);
    const sent = await google("POST", `/users/${encodeURIComponent(person.id)}/send`, {
      to: [app.id],
      subject: "Refund",
      text: "Where?",
    });
    expect(sent.status).toBeGreaterThanOrEqual(400);
    expect(ana.messages).toHaveLength(1);
    // Gmail refused the label: the thread has none of the run's.
    expect(ana.messages[0]?.labels).toEqual(["SENT"]);
    await close();
    expect(ana.trashed).toEqual([ana.messages[0]?.threadId]);
  });

  test("a reply to an address outside the allowlist is refused, and nothing is sent", async () => {
    const stub = googleStub();
    const ana = stub.mailbox("ana", ANA);
    const { google } = await liveGoogle(stub, `${AGENT},${ANA}`).open();
    const { app } = (await google("GET", "")).body;
    const person = (await google("POST", "/users", { name: "Ana", token: ana.refreshToken })).body;
    const email = (
      await google("POST", `/users/${encodeURIComponent(person.id)}/send`, {
        to: [app.id],
        subject: "Refund",
        text: "Where?",
      })
    ).body;
    // The agent answers with a Reply-To on a domain no one allowlisted.
    stub.agentReplies(stub.sent[0] as Sent, "Billing will answer.", { replyTo: "billing@elsewhere.example" });
    const [answer] = (await google("GET", `/threads/${email.thread.id}/replies`)).body;
    const before = stub.sent.length;
    const refused = await google("POST", `/users/${encodeURIComponent(person.id)}/reply`, {
      email: answer.id,
      text: "Thanks",
    });
    expect(refused.body.error).toBe("live_not_allowlisted");
    expect(stub.sent).toHaveLength(before);
  });

  test("doctor names each mailbox; one outside the allowlist fails", async () => {
    const stub = googleStub();
    const ana = stub.mailbox("ana", ANA);
    const lines = await googleMaintenance.doctor({
      env: { ...liveEnv(stub, AGENT), CHANNELSTACK_GOOGLE_USER_ANA_TOKEN: ana.refreshToken },
      fetch: stub.fetch,
      apiBase: stub.url,
      timers: systemTimers,
    });
    expect(lines).toMatchObject([
      { ok: true, text: expect.stringContaining(`the agent's mailbox, ${AGENT}`) },
      { ok: false, text: expect.stringContaining("CHANNELSTACK_LIVE_GOOGLE_ADDRESSES") },
    ]);
  });

  test("the sweep trashes run-labelled threads no ledger knows", async () => {
    const stub = googleStub();
    const ana = stub.mailbox("ana", ANA);
    const env = { ...liveEnv(stub, `${AGENT},${ANA}`), CHANNELSTACK_GOOGLE_USER_ANA_TOKEN: ana.refreshToken };
    const { google } = await liveGoogle(stub, `${AGENT},${ANA}`).open();
    const { app } = (await google("GET", "")).body;
    const person = (await google("POST", "/users", { name: "Ana", token: ana.refreshToken })).body;
    await google("POST", `/users/${encodeURIComponent(person.id)}/send`, {
      to: [app.id],
      subject: "Left behind",
      text: "x",
    });
    // The server crashed: no ledger, only the labels.
    const report = await googleMaintenance.sweep({
      env,
      fetch: stub.fetch,
      apiBase: stub.url,
      timers: systemTimers,
      entries: [],
      check: false,
      run: "unit9",
      olderThanMs: 0,
      now: Date.now(),
    });
    expect(report.removed).toHaveLength(1);
    expect(ana.trashed).toHaveLength(1);
  });
});
