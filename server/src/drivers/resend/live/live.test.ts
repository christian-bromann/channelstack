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
  test("the agent's team outside CHANNELSTACK_LIVE_RESEND_DOMAINS is refused before anything is sent", async () => {
    const stub = resendStub();
    const resend = await liveResend(stub, "people.example.org").open();
    const fixture = await resend("GET", "");
    expect(fixture.body.error).toBe("live_not_allowlisted");
    expect(stub.calls.map((call) => call.path)).toEqual(["/domains"]);
  });

  test("an address outside the allowlist is refused before Resend is asked to send", async () => {
    const stub = resendStub();
    const ana = stub.team("ana", "people.example.org");
    const resend = await liveResend(stub, "agent.example.org,people.example.org").open();
    const person = (await resend("POST", "/users", { name: "Ana", token: ana.key })).body;
    const outsider = (await resend("POST", "/users", { name: "Eve", token: stub.team("eve", "elsewhere.example").key }))
      .body;
    expect(outsider.error).toBe("live_not_allowlisted");
    const sent = await resend("POST", `/users/${encodeURIComponent(person.id)}/send`, {
      to: [outsider.id ?? "eve@elsewhere.example"],
      subject: "Hi",
      text: "hello",
    });
    expect(sent.body.error).toBeDefined();
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
