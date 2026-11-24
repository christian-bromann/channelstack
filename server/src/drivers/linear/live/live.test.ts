import { describe, expect, test } from "vitest";

import { harness } from "../../../../test/app-harness.ts";
import { type LinearStub, linearStub } from "../../../../test/linear-live-stub.ts";

/** A server whose Linear driver is live against the stub: the app's token and the allowlist set, as in CI. */
function liveLinear(stub: LinearStub, allowlist = stub.org) {
  const server = harness(
    {},
    {
      live: {
        env: {
          CHANNELSTACK_LINEAR_APP_TOKEN: stub.app.token,
          CHANNELSTACK_LIVE_LINEAR_WORKSPACES: allowlist,
          CHANNELSTACK_RUN_ID: "unit2",
        },
        fetch: stub.fetch,
        apiBase: { linear: stub.url },
      },
    },
  );
  const open = async () => {
    const { body } = await server.call("POST", "/sessions", {});
    return {
      id: body.sessionId as string,
      linear: (method: string, path: string, payload?: unknown) =>
        server.call(method, `/sessions/${body.sessionId}/linear${path}`, payload),
    };
  };
  return { ...server, open };
}

describe("exit check 5.3: Linear's allowlist holds", () => {
  test("a workspace outside CHANNELSTACK_LIVE_LINEAR_WORKSPACES is refused before anything is done there", async () => {
    const stub = linearStub();
    const ana = stub.person("ana");
    const session = await liveLinear(stub, "not-this-workspace").open();
    const person = await session.linear("POST", "/users", { name: "Ana", token: ana.token });
    expect(person.body.error).toBe("live_not_allowlisted");
    expect(person.body.message).toContain("CHANNELSTACK_LIVE_LINEAR_WORKSPACES");
    expect((await session.linear("POST", "/teams", { members: [] })).body.error).toBe("live_not_allowlisted");
    expect(stub.calls.map((call) => call.operation)).toEqual(["Viewer"]);
  });

  test("a key from another workspace, or one that acts as an app, is refused", async () => {
    const stub = linearStub();
    const elsewhere = stub.person("ana", { org: "another-workspace" });
    const session = await liveLinear(stub).open();
    expect((await session.linear("POST", "/users", { name: "Ana", token: elsewhere.token })).body.error).toBe(
      "cross_workspace_credential",
    );
    const asApp = await session.linear("POST", "/users", { name: "Robin", token: stub.app.token });
    expect(asApp.body.error).toBe("live_misconfigured");
  });
});

describe("live Linear: acting and reading back", () => {
  test("a real person delegates an issue, and the agent's activity is read back", async () => {
    const stub = linearStub();
    const ana = stub.person("ana");
    const server = liveLinear(stub);
    const session = await server.open();

    const fixture = await session.linear("GET", "");
    expect(fixture.body.app).toMatchObject({ id: stub.app.userId, accessToken: "", webhookSecret: "" });
    expect(fixture.body.apiUrl).toBe("https://api.linear.app/graphql");
    expect(JSON.stringify(fixture.body)).not.toContain(stub.app.token);

    const person = await session.linear("POST", "/users", { name: "Ana", token: ana.token });
    expect(person.body).toMatchObject({ id: ana.userId, kind: "user", email: "" });
    const team = await session.linear("POST", "/teams", { members: [ana.userId] });
    expect(team.status).toBe(200);
    // Unique in a real workspace: the run's tag in the name, a key of its own.
    expect(team.body.name).toBe("channelstack-run-unit2-1");
    expect(team.body.key).toMatch(/^[A-Z][A-Z0-9]{4}$/);

    const issue = await session.linear("POST", `/users/${ana.userId}/issues`, {
      issue: { title: "Live smoke test" },
      team: team.body.id,
    });
    expect(issue.status).toBe(200);
    expect(issue.body.identifier).toBe(`${team.body.key}-1`);
    expect(stub.calls.find((call) => call.operation === "IssueCreate")?.as).toBe("ana");

    const delegated = await session.linear("POST", `/users/${ana.userId}/delegate`, {
      app: stub.app.userId,
      issue: issue.body.id,
    });
    expect(delegated.status).toBe(200);
    // Live, Linear delivers to the agent itself: no delivery here.
    expect(delegated.body.delivery).toBeUndefined();
    const [opened] = stub.sessionsOf(issue.body.id);
    expect(delegated.body.id).toBe(opened?.id);

    // Linear delivers to the agent; here it answers the way it would.
    stub.agentSays(delegated.body.id, "thought", "Looking into it");
    const activities = await session.linear("GET", `/agent-sessions/${delegated.body.id}/activities`);
    expect(activities.body).toHaveLength(1);
    expect(activities.body[0]).toMatchObject({ type: "thought", body: "Looking into it", author: { kind: "app" } });
    expect((await session.linear("GET", `/agent-sessions/${delegated.body.id}/state`)).body).toBe("active");
  });

  test("a fake person can't act in a live workspace", async () => {
    const stub = linearStub();
    const session = await liveLinear(stub).open();
    const ben = await session.linear("POST", "/users", { name: "Ben" });
    expect(ben.status).toBe(200);
    expect((await session.linear("POST", "/teams", { members: [ben.body.id] })).body.error).toBe(
      "fake_actor_in_live_world",
    );
  });

  test("delivery chaos and Stop are refused live, before anything reaches Linear", async () => {
    const stub = linearStub();
    const ana = stub.person("ana");
    const session = await liveLinear(stub).open();
    await session.linear("POST", "/users", { name: "Ana", token: ana.token });
    const before = stub.calls.length;
    expect((await session.linear("POST", "/deliveries/x/redeliver")).body.error).toBe("unsupported_in_live");
    expect((await session.linear("POST", `/users/${ana.userId}/stop`, { session: "s" })).body).toMatchObject({
      error: "action_requires",
      data: { requires: "the browser actor" },
    });
    expect(stub.calls.length).toBe(before);
  });
});

describe("exit check 5.2: Linear cleanup", () => {
  test("closing the session deletes its teams, and with them their issues", async () => {
    const stub = linearStub();
    const ana = stub.person("ana");
    const server = liveLinear(stub);
    const session = await server.open();
    await session.linear("POST", "/users", { name: "Ana", token: ana.token });
    const team = await session.linear("POST", "/teams", { members: [ana.userId] });
    await server.call("DELETE", `/sessions/${session.id}`);
    expect(stub.team(team.body.id)?.deleted).toBe(true);
    expect(stub.calls.find((call) => call.operation === "TeamDelete")?.as).toBe("ana");
  });
});
