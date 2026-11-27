import { describe, expect, test } from "vitest";

import { harness } from "../../../../test/app-harness.ts";
import { type ResendStub, resendStub } from "../../../../test/resend-live-stub.ts";
import { systemTimers } from "../../../core/clock/index.ts";
import { resendMaintenance } from "./maintenance.ts";

/** A server whose Resend driver is live against the stub: the agent's team's key and the allowlist set, as in CI. */
function liveResend(stub: ResendStub, allowlist: string) {
  const server = harness(
    {},
    {
      live: {
        env: {
          CHANNELSTACK_RESEND_API_KEY: stub.agent.key,
          CHANNELSTACK_LIVE_RESEND_DOMAINS: allowlist,
          CHANNELSTACK_RUN_ID: "unit8",
        },
        fetch: stub.fetch,
        apiBase: { resend: stub.url },
      },
    },
  );
  const open = async () => {
    const { body } = await server.call("POST", "/sessions", {});
    return (method: string, path: string, payload?: unknown) =>
      server.call(method, `/sessions/${body.sessionId}/resend${path}`, payload);
  };
  return { ...server, open };
}

describe("exit check 8.7: Resend live", () => {
  test("a failure of Resend's own on the first check isn't kept: the next action asks again", async () => {
    const stub = resendStub();
    let failures = 1;
    // The platform's own failure, once: a 503 with no body of its own.
    const flaky = (async (input: string | URL | Request, init?: RequestInit) =>
      failures-- > 0 ? new Response("", { status: 503 }) : stub.fetch(input, init)) as typeof fetch;
    const resend = await liveResend({ ...stub, fetch: flaky }, "agent.example.org").open();
    const first = await resend("GET", "");
    expect([first.status, first.body.error]).toEqual([409, "http_503"]);
    const second = await resend("GET", "");
    expect(second.status).toBe(200);
  });

  test("the agent's team outside CHANNELSTACK_LIVE_RESEND_DOMAINS is refused before anything is sent", async () => {
    const stub = resendStub();
    const resend = await liveResend(stub, "people.example.org").open();
    const fixture = await resend("GET", "");
    expect(fixture.body.error).toBe("live_not_allowlisted");
    expect(stub.calls.map((call) => call.path)).toEqual(["/domains"]);
  });

  test("a person whose team's domain is outside the allowlist is refused, and nothing is sent", async () => {
    const stub = resendStub();
    const resend = await liveResend(stub, "agent.example.org,people.example.org").open();
    const eve = stub.team("eve", "elsewhere.example");
    const outsider = await resend("POST", "/users", { name: "Eve", token: eve.key });
    expect(outsider.body.error).toBe("live_not_allowlisted");
    expect(outsider.body.message).toContain("elsewhere.example");
    // Only who the keys are was asked: no email went out.
    expect(stub.calls.filter((call) => call.path !== "/domains")).toEqual([]);
    expect(stub.sent).toEqual([]);
  });

  test("a person's reply to an address the agent's answer names outside the allowlist is refused, and nothing is sent", async () => {
    const stub = resendStub();
    const ana = stub.team("ana", "people.example.org");
    const resend = await liveResend(stub, "agent.example.org,people.example.org").open();
    const { app } = (await resend("GET", "")).body;
    const person = (await resend("POST", "/users", { name: "Ana", token: ana.key })).body;
    const user = `/users/${encodeURIComponent(person.id)}`;
    const email = (await resend("POST", `${user}/send`, { to: [app.id], subject: "Refund", text: "Where?" })).body;
    // The agent answers twice: once with a Reply-To, once with a Cc, each on a domain no one allowlisted.
    const first = stub.sent[0] as NonNullable<(typeof stub.sent)[0]>;
    stub.agentReplies(first, "Billing will answer.", { replyTo: ["billing@elsewhere.example"] });
    stub.agentReplies(first, "I asked my boss.", { cc: ["boss@elsewhere.example"] });
    const [toReplyTo, withCc] = (await resend("GET", `/threads/${email.thread.id}/replies`)).body;
    const before = stub.sent.length;
    // A reply goes to the Reply-To; a reply to all, to the Cc too.
    for (const [answer, all] of [
      [toReplyTo, false],
      [withCc, true],
    ] as const) {
      const refused = await resend("POST", `${user}/reply`, { email: answer.id, text: "Thanks", all });
      expect(refused.body.error).toBe("live_not_allowlisted");
      // Which address, redacted: it names the allowlist to change.
      expect(refused.body.message).toContain("CHANNELSTACK_LIVE_RESEND_DOMAINS");
    }
    // Only to the agent, the same answer's reply goes out.
    expect((await resend("POST", `${user}/reply`, { email: withCc.id, text: "Thanks" })).body.error).toBeUndefined();
    expect(stub.sent).toHaveLength(before + 1);
  });

  test("an agent address outside the allowlist is refused before anything is sent", async () => {
    const stub = resendStub();
    const server = harness(
      {},
      {
        live: {
          env: {
            CHANNELSTACK_RESEND_API_KEY: stub.agent.key,
            CHANNELSTACK_RESEND_ADDRESS: "my-agent@elsewhere.example",
            CHANNELSTACK_LIVE_RESEND_DOMAINS: "agent.example.org",
            CHANNELSTACK_RUN_ID: "unit8",
          },
          fetch: stub.fetch,
          apiBase: { resend: stub.url },
        },
      },
    );
    const { body } = await server.call("POST", "/sessions", {});
    const fixture = await server.call("GET", `/sessions/${body.sessionId}/resend`);
    // The team hasn't verified that domain, and it isn't allowlisted: either way, nothing is sent.
    expect(fixture.body.error).toBe("live_misconfigured");
    expect(stub.sent).toEqual([]);
  });

  test("a person emails the agent from their own team, and its answer is read back in the thread", async () => {
    const stub = resendStub();
    const ana = stub.team("ana", "people.example.org");
    const resend = await liveResend(stub, "agent.example.org,people.example.org").open();
    const { app } = (await resend("GET", "")).body;
    expect(app.address).toBe("my-agent@agent.example.org");
    const person = (await resend("POST", "/users", { name: "Ana", token: ana.key })).body;
    expect(person.address).toBe("ana@people.example.org");

    const email = (
      await resend("POST", `/users/${encodeURIComponent(person.id)}/send`, {
        to: [app.id],
        subject: "Refund",
        text: "Where is my refund?",
      })
    ).body;
    expect(email.error, email.message).toBeUndefined();
    const [out] = stub.sent;
    expect(out).toMatchObject({ team: "ana", to: ["my-agent@agent.example.org"], subject: "Refund" });
    expect(out?.headers["x-channelstack-run"]).toMatch(/^channelstack-run-unit8/);

    stub.agentReplies(out as NonNullable<typeof out>, "Your refund was sent today.");
    const replies = (await resend("GET", `/threads/${email.thread.id}/replies`)).body;
    expect(replies).toMatchObject([{ author: { name: "my-agent", kind: "app" }, text: "Your refund was sent today." }]);
    // What a person does live is the platform's to deliver: channelstack's deliveries are the fake's.
    expect((await resend("GET", "/deliveries")).body.error).toBe("unsupported_in_live");
  });

  test("mail in a person's inbox from before the session is neither read again nor shown", async () => {
    const stub = resendStub();
    const ana = stub.team("ana", "people.example.org");
    // An answer an earlier run left in Ana's inbox, an hour ago.
    stub.agentReplies(
      { from: "ana@people.example.org", subject: "Old", messageId: "<old@people.example.org>" } as never,
      "Old answer.",
    );
    const old = stub.sent[0] as NonNullable<(typeof stub.sent)[0]>;
    old.at = new Date(Date.now() - 3_600_000).toISOString();
    const resend = await liveResend(stub, "agent.example.org,people.example.org").open();
    await resend("GET", "");
    const person = (await resend("POST", "/users", { name: "Ana", token: ana.key })).body;
    const inbox = (await resend("GET", `/users/${encodeURIComponent(person.id)}/inbox`)).body;
    expect(inbox).toEqual([]);
    expect(stub.calls.map((call) => call.path)).not.toContain(`/emails/receiving/${old.id}`);
  });

  test("doctor names each team and its domain; a team outside the allowlist fails", async () => {
    const stub = resendStub();
    const ana = stub.team("ana", "people.example.org");
    const lines = await resendMaintenance.doctor?.({
      env: {
        CHANNELSTACK_RESEND_API_KEY: stub.agent.key,
        CHANNELSTACK_RESEND_USER_ANA_TOKEN: ana.key,
        CHANNELSTACK_LIVE_RESEND_DOMAINS: "agent.example.org",
      },
      fetch: stub.fetch,
      apiBase: stub.url,
      timers: systemTimers,
    } as unknown as Parameters<NonNullable<typeof resendMaintenance.doctor>>[0]);
    expect(JSON.stringify(lines)).toContain("agent.example.org");
    expect(JSON.stringify(lines)).toContain("CHANNELSTACK_LIVE_RESEND_DOMAINS");
  });
});
