import { randomString } from "../src/core/secrets/index.ts";

/**
 * A stand-in for real Linear's GraphQL API in unit tests of live mode: a workspace in memory that
 * answers the operations the live backend sends (by operation name), in Linear's shapes, and
 * records each with whose credential sent it. Delegating an issue to the app opens an agent
 * session, as Linear does; `agentSays` adds the app's activity, as the agent would.
 */
export interface LinearStub {
  readonly url: string;
  fetch: typeof fetch;
  readonly org: string;
  readonly app: { token: string; userId: string };
  person(name: string, options?: { org?: string; admin?: boolean }): { token: string; userId: string };
  readonly calls: Array<{ operation: string; as: string }>;
  agentSays(session: string, type: "thought" | "response", body: string): void;
  sessionsOf(issue: string): Array<{ id: string }>;
  team(id: string): { id: string; name: string; deleted: boolean } | undefined;
}

const uuid = () =>
  `${randomString(8, "0123456789abcdef")}-${randomString(4, "0123456789abcdef")}-4${randomString(3, "0123456789abcdef")}-a${randomString(3, "0123456789abcdef")}-${randomString(12, "0123456789abcdef")}`;

export function linearStub(options: { org?: string } = {}): LinearStub {
  const org = options.org ?? uuid();
  const app = { token: `lin_oauth_${randomString(32, "0123456789abcdef")}`, userId: uuid() };
  const people = new Map<string, { id: string; name: string; admin: boolean; org: string; app: boolean }>([
    [app.token, { id: app.userId, name: "robin", admin: false, org, app: true }],
  ]);
  const users = new Map([
    [app.userId, { id: app.userId, name: "robin", displayName: "robin", admin: false, guest: false }],
  ]);
  const teams = new Map<
    string,
    { id: string; key: string; name: string; deleted: boolean; states: unknown[]; issues: number }
  >();
  const issues = new Map<
    string,
    Record<string, unknown> & { id: string; team: string; comments: Array<Record<string, unknown>> }
  >();
  const sessions = new Map<
    string,
    { id: string; issue: string; creator: string; createdAt: string; activities: Array<Record<string, unknown>> }
  >();
  const calls: LinearStub["calls"] = [];
  let clock = Date.parse("2026-11-23T10:00:00Z");
  const now = () => {
    clock += 1000;
    return new Date(clock).toISOString();
  };

  const issueWire = (issue: typeof issues extends Map<string, infer V> ? V : never) => ({
    ...issue,
    team: { id: issue.team },
    state: { id: issue.state },
    labels: { nodes: [] },
    assignee: null,
    delegate: issue.delegate ? { id: issue.delegate } : null,
    creator: { id: issue.creator },
    parent: null,
    comments: { nodes: issue.comments },
  });
  const sessionWire = (session: typeof sessions extends Map<string, infer V> ? V : never) => ({
    id: session.id,
    status: session.activities.some((activity) => (activity.content as { type: string }).type === "response")
      ? "complete"
      : session.activities.length > 0
        ? "active"
        : "pending",
    slugId: session.id.slice(0, 8),
    summary: null,
    plan: null,
    createdAt: session.createdAt,
    updatedAt: session.createdAt,
    startedAt: null,
    endedAt: null,
    issue: { id: session.issue },
    appUser: { id: app.userId },
    creator: { id: session.creator },
    comment: null,
    externalLinks: [],
    activities: { nodes: session.activities },
  });

  const answer = (
    operation: string,
    who: { id: string; admin: boolean; org: string; app: boolean },
    v: any,
  ): unknown => {
    switch (operation) {
      case "Viewer": {
        const user = users.get(who.id);
        return {
          viewer: {
            id: who.id,
            name: user?.name,
            displayName: user?.displayName,
            admin: who.admin,
            guest: false,
            app: who.app,
          },
          organization: { id: who.org, name: "Stub", urlKey: "stub" },
        };
      }
      case "User":
        return { user: users.get(v.id) };
      case "TeamCreate": {
        const team = {
          id: uuid(),
          key: v.input.key,
          name: v.input.name,
          deleted: false,
          issues: 0,
          states: [
            { id: uuid(), name: "Backlog", type: "backlog", color: "#bec2c8", position: 0 },
            { id: uuid(), name: "Todo", type: "unstarted", color: "#e2e2e2", position: 1 },
          ],
        };
        teams.set(team.id, team);
        return { teamCreate: { team: { ...team, states: { nodes: team.states } } } };
      }
      case "TeamDelete": {
        const team = teams.get(v.id);
        if (!team || team.deleted) throw Object.assign(new Error("Entity not found"), { code: "INPUT_ERROR" });
        team.deleted = true;
        return { teamDelete: { success: true } };
      }
      case "Teams":
        return {
          teams: {
            nodes: [...teams.values()]
              .filter((team) => !team.deleted)
              .map(({ id, name }) => ({ id, name, createdAt: new Date(clock).toISOString() })),
          },
        };
      case "IssueCreate": {
        const team = teams.get(v.input.teamId);
        if (!team) throw Object.assign(new Error("Team not found"), { code: "INPUT_ERROR" });
        const at = now();
        const issue = {
          id: uuid(),
          number: ++team.issues,
          identifier: `${team.key}-${team.issues}`,
          title: v.input.title,
          description: v.input.description ?? null,
          priority: v.input.priority ?? 0,
          createdAt: at,
          updatedAt: at,
          startedAt: null,
          completedAt: null,
          canceledAt: null,
          team: team.id,
          state: (team.states[0] as { id: string }).id,
          delegate: v.input.delegateId,
          creator: who.id,
          comments: [],
        };
        issues.set(issue.id, issue);
        return { issueCreate: { issue: issueWire(issue) } };
      }
      case "IssueUpdate": {
        const issue = issues.get(v.id);
        if (!issue) throw Object.assign(new Error("Issue not found"), { code: "INPUT_ERROR" });
        if (v.input.delegateId === app.userId && issue.delegate !== app.userId) {
          // Linear opens an agent session when an issue is delegated to an agent.
          const id = uuid();
          sessions.set(id, { id, issue: issue.id, creator: who.id, createdAt: now(), activities: [] });
        }
        if (v.input.delegateId !== undefined) issue.delegate = v.input.delegateId;
        if (v.input.title !== undefined) issue.title = v.input.title;
        return { issueUpdate: { issue: issueWire(issue) } };
      }
      case "RefreshIssue":
        return { issue: issueWire(issues.get(v.id) as never) };
      case "RefreshSessions":
        if (!who.app) throw Object.assign(new Error("Only the app reads its sessions"), { code: "FORBIDDEN" });
        return { agentSessions: { nodes: [...sessions.values()].reverse().map(sessionWire) } };
      case "RefreshSession":
        return { agentSession: sessionWire(sessions.get(v.id) as never) };
      case "CommentCreate": {
        const issue = issues.get(v.input.issueId);
        if (!issue) throw Object.assign(new Error("Issue not found"), { code: "INPUT_ERROR" });
        const at = now();
        const comment = {
          id: uuid(),
          body: v.input.body,
          createdAt: at,
          updatedAt: at,
          editedAt: null,
          user: { id: who.id },
          parent: v.input.parentId ? { id: v.input.parentId } : null,
          agentSession: null,
        };
        issue.comments.push(comment);
        return { commentCreate: { comment } };
      }
      default:
        throw Object.assign(new Error(`The stub doesn't answer ${operation}`), { code: "INPUT_ERROR" });
    }
  };

  const url = "https://linear.stub/graphql";
  const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (target !== url) throw new Error(`The live backend called ${target}, not the stub`);
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const token = authorization.replace(/^Bearer /, "");
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: unknown };
    const operation = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "query";
    const who = people.get(token);
    calls.push({ operation, as: who?.name ?? "nobody" });
    // A personal key goes as it is, an OAuth token as a bearer token: Linear refuses the other way round.
    const rightScheme = token.startsWith("lin_api_") ? authorization === token : authorization.startsWith("Bearer ");
    if (!who || !rightScheme) {
      return Response.json(
        { errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] },
        { status: 401 },
      );
    }
    try {
      return Response.json({ data: answer(operation, who, variables) });
    } catch (error) {
      return Response.json({
        errors: [
          {
            message: (error as Error).message,
            extensions: {
              code: (error as { code?: string }).code ?? "INPUT_ERROR",
              userPresentableMessage: (error as Error).message,
            },
          },
        ],
      });
    }
  }) as typeof fetch;

  return {
    url,
    fetch: stubFetch,
    org,
    app,
    calls,
    person(name, personOptions = {}) {
      const userId = uuid();
      const token = `lin_api_${randomString(40, "0123456789abcdefghijklmnopqrstuvwxyz")}`;
      people.set(token, {
        id: userId,
        name,
        admin: personOptions.admin ?? true,
        org: personOptions.org ?? org,
        app: false,
      });
      users.set(userId, { id: userId, name, displayName: name, admin: personOptions.admin ?? true, guest: false });
      return { token, userId };
    },
    agentSays(sessionId, type, body) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`No session ${sessionId}`);
      session.activities.push({
        id: uuid(),
        createdAt: now(),
        ephemeral: false,
        signal: null,
        signalMetadata: null,
        user: { id: app.userId },
        sourceComment: null,
        content: { type, body },
      });
    },
    sessionsOf: (issue) => [...sessions.values()].filter((session) => session.issue === issue),
    team: (id) => teams.get(id),
  };
}
