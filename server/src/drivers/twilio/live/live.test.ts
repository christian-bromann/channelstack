import { describe, expect, test } from "vitest";

import { harness } from "../../../../test/app-harness.ts";
import { type TwilioStub, twilioStub } from "../../../../test/twilio-live-stub.ts";
import { systemTimers } from "../../../core/clock/index.ts";
import { twilioMaintenance } from "./maintenance.ts";

const AGENT_NUMBER = "+14155550100";

/** A server whose Twilio driver is live against the stub: the agent's account, its number and the allowlist set, as in CI. */
function liveTwilio(stub: TwilioStub, allowlist: string, number = AGENT_NUMBER) {
  const server = harness(
    {},
    {
      live: {
        env: {
          CHANNELSTACK_TWILIO_ACCOUNT_SID: stub.agent.sid,
          CHANNELSTACK_TWILIO_AUTH_TOKEN: stub.agent.token,
          CHANNELSTACK_TWILIO_NUMBER: number,
          CHANNELSTACK_LIVE_TWILIO_NUMBERS: allowlist,
          CHANNELSTACK_RUN_ID: "unit10",
        },
        fetch: stub.fetch,
        apiBase: { twilio: stub.url },
      },
    },
  );
  const open = async () => {
    const { body } = await server.call("POST", "/sessions", {});
    const twilio = (method: string, path: string, payload?: unknown) =>
      server.call(method, `/sessions/${body.sessionId}/twilio${path}`, payload);
    return Object.assign(twilio, { close: () => server.call("DELETE", `/sessions/${body.sessionId}`) });
  };
  return { ...server, open };
}

/** What a sweep is handed: the server's environment and the stub. */
const maintenanceInput = (stub: TwilioStub, env: Record<string, string>) => ({
  env: {
    CHANNELSTACK_TWILIO_ACCOUNT_SID: stub.agent.sid,
    CHANNELSTACK_TWILIO_AUTH_TOKEN: stub.agent.token,
    CHANNELSTACK_TWILIO_NUMBER: AGENT_NUMBER,
    ...env,
  },
  fetch: stub.fetch,
  apiBase: stub.url,
  timers: systemTimers,
});

describe("exit check 10.7: Twilio live", () => {
  test("the agent's number outside CHANNELSTACK_LIVE_TWILIO_NUMBERS is refused before anything is sent", async () => {
    const stub = twilioStub();
    const twilio = await liveTwilio(stub, "+14155550199").open();
    expect((await twilio("GET", "")).body.error).toBe("live_not_allowlisted");
    expect(stub.calls.every((call) => call.method === "GET")).toBe(true);
    expect(stub.messages).toEqual([]);
  });

  test("a person whose number is outside the allowlist is refused, and nothing is sent", async () => {
    const stub = twilioStub();
    const eve = stub.account("eve", ["+14155550177"]);
    const twilio = await liveTwilio(stub, AGENT_NUMBER).open();
    const outsider = await twilio("POST", "/users", { name: "Eve", token: eve.credential, number: "+14155550177" });
    expect(outsider.body.error).toBe("live_not_allowlisted");
    expect(outsider.body.message).toContain("CHANNELSTACK_LIVE_TWILIO_NUMBERS");
    expect(stub.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  test("a person texts from their own account; the agent's answer is read back; closing the session deletes every message", async () => {
    const stub = twilioStub();
    const ana = stub.account("ana", ["+14155550101"]);
    const twilio = await liveTwilio(stub, `${AGENT_NUMBER},+14155550101`).open();
    const { app } = (await twilio("GET", "")).body;
    expect(app.number).toBe(AGENT_NUMBER);
    // Ana's account has one allowlisted number: it is hers.
    const person = (await twilio("POST", "/users", { name: "Ana", token: ana.credential })).body;
    expect(person.number).toBe("+14155550101");

    const text = (await twilio("POST", `/users/${encodeURIComponent(person.id)}/text`, { body: "Where?", to: app.id }))
      .body;
    expect(text.error, text.message).toBeUndefined();
    expect(stub.calls.find((call) => call.method === "POST")?.as).toBe("ana");

    stub.agentReplies("+14155550101", "Your order shipped.");
    const replies = (await twilio("GET", `/conversations/${text.conversation.id}/replies`)).body;
    expect(replies).toMatchObject([
      { author: { name: "my-agent", kind: "app" }, text: "Your order shipped.", to: "+14155550101" },
    ]);
    // What a person does live is the platform's to deliver: channelstack's deliveries are the fake's.
    expect((await twilio("GET", "/deliveries")).body.error).toBe("unsupported_in_live");
    // Four messages: Ana's and its copy at the agent, the answer and its copy at Ana. All go.
    expect(stub.messages).toHaveLength(4);
    await twilio.close();
    expect(stub.messages).toEqual([]);
  });

  test("a person on the agent's own account, by the number the test names", async () => {
    const stub = twilioStub();
    const shared = stub.account("shared", ["+14155550102", "+14155550103"]);
    const twilio = await liveTwilio(stub, `${AGENT_NUMBER},+14155550102,+14155550103`).open();
    await twilio("GET", "");
    const ambiguous = await twilio("POST", "/users", { name: "Ana", token: shared.credential });
    expect(ambiguous.body.error).toBe("live_misconfigured");
    const ana = (await twilio("POST", "/users", { name: "Ana", token: shared.credential, number: "+14155550103" }))
      .body;
    expect(ana.number).toBe("+14155550103");
  });

  test("a phone that's off is fake only; a person without an account is misconfigured", async () => {
    const stub = twilioStub();
    const twilio = await liveTwilio(stub, AGENT_NUMBER).open();
    await twilio("GET", "");
    expect(
      (await twilio("POST", "/users", { name: "Ana", reachable: false, token: stub.agent.credential })).body.error,
    ).toBe("unsupported_in_live");
    expect((await twilio("POST", "/users", { name: "Ben" })).body.error).toBe("live_misconfigured");
  });

  test("doctor names each number; a number outside the allowlist fails", async () => {
    const stub = twilioStub();
    const ana = stub.account("ana", ["+14155550101"]);
    const lines =
      (await twilioMaintenance.doctor(
        maintenanceInput(stub, {
          CHANNELSTACK_TWILIO_USER_ANA_TOKEN: ana.credential,
          CHANNELSTACK_LIVE_TWILIO_NUMBERS: AGENT_NUMBER,
        }),
      )) ?? [];
    expect(lines.map((line) => line.ok)).toEqual([true, false]);
    expect(lines[0]?.text).toContain(AGENT_NUMBER);
    expect(lines[1]?.text).toContain("CHANNELSTACK_LIVE_TWILIO_NUMBERS");
    // No secret in what doctor says.
    expect(JSON.stringify(lines)).not.toContain(ana.token);
  });

  test("the sweep deletes what a crashed run's ledger lists, with the account each is on", async () => {
    const stub = twilioStub();
    const ana = stub.account("ana", ["+14155550101"]);
    stub.agentReplies("+14155550101", "Left behind.");
    const [atAgent, atAna] = stub.messages;
    const entry = (sid: string, by: string, workspace: string) => ({
      id: sid,
      channel: "twilio",
      kind: "message",
      ref: { sid },
      workspace,
      by,
      run: "crashed",
      session: "s",
      createdAt: 0,
    });
    const input = {
      ...maintenanceInput(stub, {
        CHANNELSTACK_TWILIO_USER_ANA_TOKEN: ana.credential,
        CHANNELSTACK_LIVE_TWILIO_NUMBERS: `${AGENT_NUMBER},+14155550101`,
      }),
      entries: [entry(atAgent?.sid ?? "", "app", AGENT_NUMBER), entry(atAna?.sid ?? "", "user:ANA", "+14155550101")],
      run: undefined,
      olderThanMs: 0,
      now: Date.now(),
    };
    expect((await twilioMaintenance.sweep({ ...input, check: true })).left).toHaveLength(2);
    const report = await twilioMaintenance.sweep({ ...input, check: false });
    expect(report.removed).toHaveLength(2);
    expect(stub.messages).toEqual([]);
  });
});
