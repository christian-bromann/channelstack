import { describe, expect, test } from "vitest";

import { harness } from "../../../../test/app-harness.ts";
import { type LinearStub, linearStub } from "../../../../test/linear-live-stub.ts";
import { systemTimers } from "../../../core/clock/index.ts";
import type { LedgerEntry } from "../../../core/ledger/index.ts";
import { linearMaintenance } from "./maintenance.ts";

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

describe("R4.1: one person of the pool in parallel sessions", () => {
  test("the same person in two open sessions acts in both, and stays when one closes", async () => {
    const stub = linearStub();
    const ana = stub.person("ana");
    const server = liveLinear(stub);
    const [one, two] = [await server.open(), await server.open()];
    for (const session of [one, two]) await session.linear("POST", "/users", { name: "Ana", token: ana.token });
    const team = await one.linear("POST", "/teams", { members: [ana.userId] });
    await server.call("DELETE", `/sessions/${two.id}`);
    const issue = await one.linear("POST", `/users/${ana.userId}/issues`, {
      issue: { title: "Still here" },
      team: team.body.id,
    });
    expect(issue.status).toBe(200);
    expect(issue.body.creator).toMatchObject({ id: ana.userId });
  });

  test("R5.1: a session can't act as, or add, a person only another session holds", async () => {
    const stub = linearStub();
    const ana = stub.person("ana");
    const ben = stub.person("ben");
    const server = liveLinear(stub);
    const [one, two] = [await server.open(), await server.open()];
    await one.linear("POST", "/users", { name: "Ana", token: ana.token });
    await two.linear("POST", "/users", { name: "Ben", token: ben.token });
    const sent = stub.calls.length;
    const team = await two.linear("POST", "/teams", { members: [ben.userId, ana.userId] });
    expect(team.body.error).toBe("not_found");
    const own = await two.linear("POST", "/teams", { members: [ben.userId] });
    const issue = await two.linear("POST", `/users/${ana.userId}/issues`, {
      issue: { title: "Not mine" },
      team: own.body.id,
    });
    expect(issue.body.error).toBe("not_found");
    expect(stub.calls.slice(sent).filter((call) => call.as === "ana")).toEqual([]);
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
    expect(team.body.name).toMatch(/^channelstack-run-unit2-[a-z]{4}-1$/);
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
    // Linear answers newest first; a test reads them in the order they happened, however many a read brings.
    stub.agentSays(delegated.body.id, "thought", "Found it");
    stub.agentSays(delegated.body.id, "response", "Fixed in the login form");
    // What was read a moment ago is used again for a second (a matcher reads every 50 ms).
    const calls = stub.calls.length;
    expect((await session.linear("GET", `/agent-sessions/${delegated.body.id}/activities`)).body).toHaveLength(1);
    expect(stub.calls.length).toBe(calls);
    server.clock.advance(1_000);
    const all = await session.linear("GET", `/agent-sessions/${delegated.body.id}/activities`);
    expect(all.body.map((activity: { body: string }) => activity.body)).toEqual([
      "Looking into it",
      "Found it",
      "Fixed in the login form",
    ]);
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

describe("live Linear: teams, comments and what Linear refuses", () => {
  test("a team with its states, labels and members; a comment edited, reacted to and deleted", async () => {
    const stub = linearStub();
    const ana = stub.person("ana");
    const ben = stub.person("ben");
    const session = await liveLinear(stub).open();
    await session.linear("POST", "/users", { name: "Ana", token: ana.token });
    await session.linear("POST", "/users", { name: "Ben", token: ben.token });
    const team = await session.linear("POST", "/teams", {
      members: [ana.userId, ben.userId],
      states: [{ name: "In review", type: "started" }],
      labels: ["bug"],
    });
    expect(team.status).toBe(200);
    const made = stub.made();
    expect(made.members).toEqual([{ team: team.body.id, user: ben.userId }]);
    expect(made.states.filter((state) => state.team === team.body.id).map((state) => state.name)).toContain(
      "In review",
    );
    expect(made.labels).toEqual([{ team: team.body.id, name: "bug" }]);

    const issue = await session.linear("POST", `/users/${ana.userId}/issues`, {
      issue: { title: "Typo" },
      team: team.body.id,
    });
    const comment = await session.linear("POST", `/users/${ana.userId}/comment`, {
      body: "first",
      issue: issue.body.id,
    });
    expect(
      (await session.linear("POST", `/users/${ana.userId}/edit`, { body: "edited", comment: comment.body.id })).status,
    ).toBe(200);
    await session.linear("POST", `/users/${ben.userId}/react`, { emoji: "+1", comment: comment.body.id });
    expect(stub.made().reactions).toEqual([{ comment: comment.body.id, emoji: "+1", user: ben.userId }]);
    const notHers = await session.linear("POST", `/users/${ben.userId}/edit`, {
      body: "mine",
      comment: comment.body.id,
    });
    expect(notHers.body.error).toBe("FORBIDDEN");
    expect((await session.linear("POST", `/users/${ana.userId}/delete`, { comment: comment.body.id })).status).toBe(
      200,
    );
  });

  test("a delegation Linear opens no session for is said as such, after Linear's wait", async () => {
    const stub = linearStub();
    stub.openNoSessions();
    const ana = stub.person("ana");
    const server = liveLinear(stub);
    const session = await server.open();
    await session.linear("POST", "/users", { name: "Ana", token: ana.token });
    const team = await session.linear("POST", "/teams", { members: [ana.userId] });
    const issue = await session.linear("POST", `/users/${ana.userId}/issues`, {
      issue: { title: "Hm" },
      team: team.body.id,
    });
    const delegated = session.linear("POST", `/users/${ana.userId}/delegate`, {
      app: stub.app.userId,
      issue: issue.body.id,
    });
    // Linear's wait, a second at a time.
    for (let second = 0; second < 16; second++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      server.clock.advance(1_000);
      server.timers.advance(1_000);
    }
    const refused = await delegated;
    expect(refused.body.error).toBe("no_agent_session");
    expect(refused.body.message).toContain("within 15s");
  });

  test("a real account's role is Linear's: a test asking for another one is refused", async () => {
    const stub = linearStub();
    const ana = stub.person("ana");
    const session = await liveLinear(stub).open();
    // The stub's people are workspace admins.
    const asMember = await session.linear("POST", "/users", { name: "Ana", token: ana.token, admin: false });
    expect(asMember.body.error).toBe("live_misconfigured");
    expect(asMember.body.message).toContain("Ana's account is a workspace admin, but the test asks for admin: false");
  });
});

describe("exit check 5.2: Linear's doctor and sweep", () => {
  const env = (stub: LinearStub, person: { token: string }, extra: Record<string, string> = {}) => ({
    CHANNELSTACK_LINEAR_APP_TOKEN: stub.app.token,
    CHANNELSTACK_LINEAR_USER_ANA_TOKEN: person.token,
    CHANNELSTACK_LIVE_LINEAR_WORKSPACES: stub.org,
    ...extra,
  });
  const input = (stub: LinearStub, environment: Record<string, string>) => ({
    env: environment,
    fetch: stub.fetch,
    timers: systemTimers,
    apiBase: stub.url,
  });

  test("doctor: the app and a person in the workspace, and what isn't", async () => {
    const stub = linearStub();
    const ana = stub.person("ana");
    const ok = await linearMaintenance.doctor(input(stub, env(stub, ana)));
    expect(ok.map((check) => check.ok)).toEqual([true, true]);
    expect(ok[0]?.text).toContain(`the app in workspace ${stub.org}`);
    const elsewhere = await linearMaintenance.doctor(
      input(stub, env(stub, ana, { CHANNELSTACK_LIVE_LINEAR_WORKSPACES: "nope" })),
    );
    expect(elsewhere.every((check) => !check.ok && check.text.includes("CHANNELSTACK_LIVE_LINEAR_WORKSPACES"))).toBe(
      true,
    );
    const swapped = await linearMaintenance.doctor(
      input(stub, env(stub, ana, { CHANNELSTACK_LINEAR_APP_TOKEN: ana.token })),
    );
    expect(swapped[0]).toMatchObject({ ok: false });
    expect(swapped[0]?.text).toContain("doesn't act as an app");
  });

  test("sweep: a ledgered team once, a tagged team of the run, and the age cutoff", async () => {
    const stub = linearStub();
    const ana = stub.person("ana");
    const server = liveLinear(stub);
    const session = await server.open();
    await session.linear("POST", "/users", { name: "Ana", token: ana.token });
    const ledgered = await session.linear("POST", "/teams", { members: [ana.userId] });
    const stray = await session.linear("POST", "/teams", { members: [ana.userId], name: "stray" });
    const entry: LedgerEntry = {
      id: "unit2-1-1",
      channel: "linear",
      kind: "team",
      ref: { team: ledgered.body.id, name: ledgered.body.name },
      workspace: stub.org,
      by: "user:ANA",
      run: "unit2",
      session: session.id,
      createdAt: 0,
    };
    const sweep = (options: { check: boolean; run?: string; olderThanMs?: number; now?: number }) =>
      linearMaintenance.sweep({
        ...input(stub, env(stub, ana)),
        entries: [entry],
        check: options.check,
        run: options.run,
        olderThanMs: options.olderThanMs ?? 0,
        now: options.now ?? Date.now(),
      });
    const checked = await sweep({ check: true, run: "unit2" });
    expect(checked.left).toEqual([`team ${ledgered.body.name} (run unit2)`, `team ${stray.body.name}`]);
    // Not old enough, and not this run: left alone (the stub's clock starts at 10:00).
    const soon = Date.parse("2026-11-23T10:30:00Z");
    expect((await sweep({ check: true, olderThanMs: 3_600_000, now: soon })).left).toEqual([
      `team ${ledgered.body.name} (run unit2)`,
    ]);
    const swept = await sweep({ check: false, run: "unit2" });
    expect(swept.removed).toEqual([`team ${ledgered.body.name} (run unit2)`, `team ${stray.body.name}`]);
    expect(swept.done).toEqual([entry]);
    expect(stub.team(ledgered.body.id)?.deleted).toBe(true);
    expect(stub.team(stray.body.id)?.deleted).toBe(true);
  });
});
