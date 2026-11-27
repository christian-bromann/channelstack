import { z } from "@hono/zod-openapi";
import { GraphQLError } from "graphql";

import { BUILT_IN_APP } from "../../core/apps/index.ts";
import { iso } from "../../core/clock/index.ts";
import type { DeliveryRecord } from "../../core/delivery/index.ts";
import { ProtocolError } from "../../core/errors/index.ts";
import type { EventLog } from "../../core/events/index.ts";
import { DELIVERY_IS_THE_PLATFORMS, type LiveSupport } from "../../core/reality/index.ts";
import { type DriverRouter, pathParam, refTo, registerInspectionRoutes } from "../../core/router/index.ts";
import {
  apiCallSchema,
  DeliveryAttempt,
  DeliveryStatus,
  principalSchema,
  transcriptSchema,
} from "../../core/router/inspect.ts";
import type { LinearWorld } from "./backend.ts";
import type { FakeLinearWorld } from "./fake/world.ts";
import { renderTranscript } from "./transcript.ts";
import type {
  LinearActivityRecord,
  LinearAppRecord,
  LinearCommentRecord,
  LinearIssueRecord,
  LinearSessionRecord,
  LinearTeamRecord,
  LinearUserRecord,
} from "./world.ts";

const LinearUser = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.literal("user"),
    displayName: z.string(),
    email: z.string().optional(),
    admin: z.boolean(),
    guest: z.boolean(),
  })
  .openapi("LinearUser", { "x-channelstack-resource": { id: "id", role: "user" } });

const LinearApp = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.literal("app"),
    botUserId: z.string(),
    accessToken: z.string(),
    webhookSecret: z.string(),
    clientId: z.string(),
    clientSecret: z.string(),
  })
  .openapi("LinearApp", { "x-channelstack-resource": { id: "id", role: "app" } });

const LinearAuthor = z.discriminatedUnion("kind", [LinearUser, LinearApp]);

const LinearTeam = z
  .object({ id: z.string(), key: z.string(), name: z.string() })
  .openapi("LinearTeam", { "x-channelstack-resource": { id: "id", role: "resource" } });

const LinearDelivery = z
  .object({
    id: z.string(),
    channel: z.literal("linear"),
    /** The app it went to, by name: `my-agent`, or one a test made. */
    app: z.string(),
    type: z
      .string()
      .openapi({ description: "`Linear-Event`, the resource type: `AgentSessionEvent`, `Issue`, `Comment`." }),
    action: z.string().openapi({ description: "`created`, `prompted`, `create`, `update`, `remove`." }),
    webhookId: z.string(),
    payload: z.unknown(),
    attempts: z.array(DeliveryAttempt),
    status: DeliveryStatus,
  })
  .openapi("LinearDelivery", { "x-channelstack-resource": { id: "id" } });

const LinearIssue = z
  .object({ id: z.string(), identifier: z.string(), url: z.string(), team: LinearTeam, creator: LinearAuthor })
  .openapi("LinearIssue", { "x-channelstack-resource": { id: "id" } });

const SessionState = z.enum(["pending", "active", "stopping", "awaitingInput", "complete", "error", "stale"]);

const LinearAgentSession = z
  .object({
    id: z.string(),
    issue: LinearIssue,
    app: LinearApp,
    startedBy: LinearUser,
    // The `AgentSessionEvent` (`created`) delivery that opened the session. Fake only: live, Linear delivers to the agent itself.
    delivery: LinearDelivery.optional(),
  })
  .openapi("LinearAgentSession", { "x-channelstack-resource": { id: "id" } });

const LinearComment = z
  .object({
    id: z.string(),
    issue: LinearIssue,
    author: LinearAuthor,
    body: z.string().openapi({ description: "As a person reads it: a mention is `@name`." }),
    createdAt: z.string(),
    url: z.string(),
    session: LinearAgentSession.optional(),
    delivery: LinearDelivery.optional(),
  })
  .openapi("LinearComment", { "x-channelstack-resource": { id: "id" } });

const LinearAgentActivity = z
  .object({
    id: z.string(),
    session: LinearAgentSession,
    type: z.enum(["thought", "action", "elicitation", "response", "error", "prompt"]),
    author: LinearAuthor,
    body: z.string().optional(),
    action: z
      .object({ action: z.string(), parameter: z.string().optional(), result: z.string().optional() })
      .optional(),
    ephemeral: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("LinearAgentActivity", { "x-channelstack-resource": { id: "id" } });

const Principal = principalSchema("LinearPrincipal");

const LinearTranscript = transcriptSchema("Linear", Principal);

const LinearApiCall = apiCallSchema("linear", "LinearApiCall");

const LinearFixture = z
  .object({ app: LinearApp, apiUrl: z.string() })
  .openapi("LinearFixture", { "x-channelstack-resource": {} });

const userRef = z.string().openapi(refTo("LinearUser"));
const appRef = z.string().openapi(refTo("LinearApp"));
const teamRef = z.string().openapi(refTo("LinearTeam"));
const issueRef = z.string().openapi(refTo("LinearIssue"));
const commentRef = z.string().openapi(refTo("LinearComment"));
const sessionRef = z.string().openapi(refTo("LinearAgentSession"));
const activityRef = z.string().openapi(refTo("LinearAgentActivity"));
const Priority = z.number().int().min(0).max(4);

const UserParams = z.object({ user: pathParam("user") });
const AppParams = z.object({ app: pathParam("app") });
const IssueParams = z.object({ issue: pathParam("issue") });
const SessionParams = z.object({ agentSession: pathParam("agentSession") });
const CommentParams = z.object({ comment: pathParam("comment") });

/** Stop is a button in Linear: the `stop` signal is generated only when a person presses it. */
const IN_THE_UI: LiveSupport = {
  requires: "browser",
  reason: "Linear sends the stop signal only when a person presses Stop, and it can't be published through the API",
};
/** Linear has no redelivery mutation. */
const NO_REDELIVERY: LiveSupport = { unsupported: "Linear has no API to redeliver a webhook" };
/** Only the built-in app is wired to the live workspace: a second sandbox app is set up by hand (decision 0027, question 8). */
const ONE_LIVE_APP: LiveSupport = {
  unsupported: "Live, the Linear workspace has the built-in app only: another app needs a sandbox app of its own",
};
/** What only the app's own calls show: live, proxy mode sees them. */
const AGENT_SIDE: LiveSupport = {
  requires: "proxy",
  reason: "Linear doesn't report the app's calls; proxy mode sees them",
};

/** The Linear driver's control API: what a test's people do, and what a test reads back. */
export function registerLinearRoutes(
  router: DriverRouter,
  deps: {
    /** The fake world, which every route uses on a fake driver and the fake-only routes use always. */
    fake: FakeLinearWorld;
    /** The live world, on a live driver. */
    live: LinearWorld | undefined;
    events: EventLog;
    apiUrl: () => string;
    /** One of an app's secrets: the built-in app's unless another is named. */
    secret: (name: string, app?: string) => string;
  },
): void {
  const { fake } = deps;
  /** The world a route that works live acts in. Routes that don't are refused live by the router, and use the fake. */
  const world: LinearWorld = deps.live ?? fake;
  const isLive = deps.live !== undefined;
  const { store } = world;
  const stability = "experimental";

  /** A refusal of the fake's own world (Linear's `INPUT_ERROR`), as the control API's error. */
  const asProtocol = async <T>(run: () => T | Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof GraphQLError) throw new ProtocolError("invalid_argument", error.message);
      throw error;
    }
  };

  // --- Records → wire ---------------------------------------------------------------------------

  const userWire = (user: LinearUserRecord) => ({
    id: user.id,
    name: user.name,
    kind: "user" as const,
    displayName: user.displayName,
    email: user.email,
    admin: user.admin,
    guest: user.guest,
  });
  const appWire = (app: LinearAppRecord = store.app) => ({
    id: app.userId,
    name: app.name,
    kind: "app" as const,
    botUserId: app.userId,
    // A live app's credentials stay on the server: the control API never returns them.
    accessToken: isLive ? "" : deps.secret("oauthToken", app.name),
    webhookSecret: isLive ? "" : deps.secret("webhookSecret", app.name),
    clientId: isLive ? "" : deps.secret("clientId", app.name),
    clientSecret: isLive ? "" : deps.secret("clientSecret", app.name),
  });
  const authorWire = (id: string) => {
    const app = store.appByUser(id);
    return app ? appWire(app) : userWire(store.user(id) as LinearUserRecord);
  };
  const principal = (id: string) => {
    const { id: principalId, name, kind } = authorWire(id);
    return { id: principalId, name, kind };
  };
  const teamWire = (team: LinearTeamRecord) => ({ id: team.id, key: team.key, name: team.name });
  const issueWire = (issue: LinearIssueRecord) => ({
    id: issue.id,
    identifier: issue.identifier,
    url: world.links.issue(issue),
    team: teamWire(store.team(issue.team)),
    creator: authorWire(issue.creator),
  });
  const deliveryWire = ({ request, attempts }: DeliveryRecord) => ({
    id: request.id,
    channel: "linear" as const,
    app: request.app ?? BUILT_IN_APP,
    type: request.type,
    action: String(request.meta?.action ?? ""),
    webhookId: String((request.meta?.payload as { webhookId?: string } | undefined)?.webhookId ?? ""),
    payload: request.meta?.payload,
    attempts,
    status: attempts.at(-1)?.status ?? ("pending" as const),
  });
  const caused = (session: string, id: string | undefined) =>
    // Only the fake delivers: live, Linear delivers to the agent itself, and there is none here.
    id === undefined ? undefined : deliveryWire(fake.delivery(session, id));
  const sessionWire = (session: string, record: LinearSessionRecord) => ({
    id: record.id,
    issue: issueWire(store.issue(record.issue)),
    app: appWire(store.appByUser(record.appUser)),
    startedBy: userWire(store.user(record.creator) as LinearUserRecord),
    delivery: caused(session, record.delivery),
  });
  const commentWire = (session: string, comment: LinearCommentRecord) => {
    const issue = store.issue(comment.issue);
    const owned = comment.session === undefined ? undefined : store.sessions.find(comment.session);
    return {
      id: comment.id,
      issue: issueWire(issue),
      author: authorWire(comment.user),
      body: world.readable(comment.body),
      createdAt: iso(comment.createdAt),
      url: world.links.comment(issue, comment.id),
      session: owned ? sessionWire(session, owned) : undefined,
      delivery: caused(session, comment.delivery),
    };
  };
  const activityWire = (session: string, activity: LinearActivityRecord) => {
    const { content } = activity;
    return {
      id: activity.id,
      session: sessionWire(session, store.sessions.find(activity.session) as LinearSessionRecord),
      type: content.type,
      author: authorWire(activity.user),
      body: content.body === undefined ? undefined : world.readable(content.body),
      action:
        content.type === "action"
          ? { action: content.action ?? "", parameter: content.parameter, result: content.result ?? undefined }
          : undefined,
      ephemeral: activity.ephemeral,
      createdAt: iso(activity.createdAt),
    };
  };

  // --- Handles → records ------------------------------------------------------------------------

  const person = (session: string, id: string) => store.users.get(session, id);
  const teamOf = (session: string, id: string) => store.teams.get(session, id);
  const issueOf = (session: string, id: string) => store.issues.get(session, id);
  const commentOf = (session: string, id: string) => store.comments.get(session, id);
  const sessionOf = (session: string, id: string) => store.sessions.get(session, id);
  const activityOf = (session: string, id: string) => store.activities.get(session, id);
  /** An app by its handle (its app user's id) or its name. */
  const appOf = (ref: string): LinearAppRecord => {
    const app = store.appOf(ref);
    if (!app) throw new ProtocolError("not_found", `There is no Linear app "${ref}"`, { app: ref });
    return app;
  }; /** A person may act in a team they are a member of; anyone but a guest may act in any team of the workspace. */
  const mayAct = (user: LinearUserRecord, team: LinearTeamRecord) => {
    if (user.guest && !team.members.includes(user.id)) {
      throw new ProtocolError(
        { platform: "forbidden", status: 409 },
        `${user.name} is a guest and not a member of ${team.key}`,
      );
    }
  };
  const actor = (session: string, userId: string, issue: LinearIssueRecord) => {
    const user = person(session, userId);
    mayAct(user, store.team(issue.team));
    return user;
  };

  // --- The fixture ----------------------------------------------------------------------------

  router.route({
    method: "get",
    path: "",
    summary: "The Linear fixture: the agent's app, and where the agent reaches the fake",
    response: LinearFixture,
    factory: { on: "Session", name: "linear" },
    stability,
    handler: () => ({ app: appWire(), apiUrl: isLive ? "https://api.linear.app/graphql" : `${deps.apiUrl()}/graphql` }),
  });

  router.route({
    method: "post",
    path: "/users",
    summary: "Create a person in the workspace",
    body: z
      .object({
        name: z.string().min(1),
        id: z.string().optional(),
        displayName: z.string().optional(),
        email: z.string().optional(),
        admin: z.boolean().optional(),
        guest: z.boolean().optional(),
        token: z.string().min(1).optional().openapi({
          description:
            "A real person's personal API key in the live workspace. Read from CHANNELSTACK_LINEAR_USER_<NAME>_TOKEN when left out.",
          "x-channelstack-credential": "CHANNELSTACK_LINEAR_USER_{name}_TOKEN",
        }),
      })
      .openapi("LinearUserOptions"),
    response: LinearUser,
    factory: {
      on: "LinearFixture",
      name: "createUser",
      options: ["name", "id", "displayName", "email", "admin", "guest", "token"],
    },
    stability,
    handler: async ({ session, body }) => userWire(await world.createUser(session.id, body)),
  });

  // --- Apps (decision 0027) ---------------------------------------------------------------------

  router.route({
    method: "post",
    path: "/apps",
    summary:
      "Make another OAuth app in the workspace, installed with `actor=app`: its own app user (mentionable and assignable), access token, client and webhook secret. Or return the one made with this name and settings. Its webhooks go to CHANNELSTACK_LINEAR_APP_<NAME>_WEBHOOK_URL",
    body: z
      .object({
        name: z
          .string()
          .min(1)
          .openapi({ description: "How people mention it: 1 to 32 lower-case letters, digits and hyphens" }),
        events: z.array(z.string().min(1)).optional().openapi({
          description:
            "The webhook resource types it subscribes to. Default: the built-in app's, `AgentSessionEvent`, `Issue` and `Comment`",
        }),
      })
      .openapi("LinearAppOptions"),
    response: LinearApp,
    errors: ["invalid_argument"],
    factory: { on: "LinearFixture", name: "createApp", options: ["name", "events"] },
    live: ONE_LIVE_APP,
    stability,
    handler: ({ session, body }) => appWire(fake.createApp(session.id, body)),
  });

  router.route({
    method: "get",
    path: "/apps",
    summary: "The workspace's apps: the built-in one first, then the others in the order they were made",
    response: z.array(LinearApp).openapi("LinearApps"),
    sdkMethod: { on: "LinearFixture", name: "apps" },
    stability,
    handler: () => store.apps.all().map((app) => appWire(app)),
  });

  router.route({
    method: "post",
    path: "/apps/{app}/comment",
    summary:
      "An app a test made comments on an issue, as its own `commentCreate` would. Its mention of another app is refused (to confirm, B6)",
    params: AppParams,
    body: z.object({ body: z.string().min(1), issue: issueRef }).openapi("LinearAppCommentBody"),
    response: LinearComment,
    errors: ["not_found", "invalid_argument"],
    sdkMethod: { on: "LinearApp", name: "comment", args: ["body"], options: ["issue"] },
    live: ONE_LIVE_APP,
    stability,
    handler: async ({ session, params, body }) => {
      const app = fake.scripted(params.app);
      const issue = issueOf(session.id, body.issue);
      return commentWire(
        session.id,
        await asProtocol(() => fake.comment(issue, app.userId, fake.markdown(session.id, body.body))),
      );
    },
  });

  router.route({
    method: "post",
    path: "/apps/{app}/reply",
    summary: "An app a test made replies in a comment's thread, as its own `commentCreate` with a `parentId` would",
    params: AppParams,
    body: z.object({ body: z.string().min(1), comment: commentRef }).openapi("LinearAppReplyBody"),
    response: LinearComment,
    errors: ["not_found", "invalid_argument"],
    sdkMethod: { on: "LinearApp", name: "reply", args: ["body"], options: ["comment"] },
    live: ONE_LIVE_APP,
    stability,
    handler: async ({ session, params, body }) => {
      const app = fake.scripted(params.app);
      const parent = commentOf(session.id, body.comment);
      const issue = store.issue(parent.issue);
      return commentWire(
        session.id,
        await asProtocol(() => fake.comment(issue, app.userId, fake.markdown(session.id, body.body), parent)),
      );
    },
  });

  router.route({
    method: "post",
    path: "/teams",
    summary:
      "Create a team: its members, workflow states and labels. Without a key one is made up, so parallel tests never share one",
    body: z
      .object({
        key: z.string().optional(),
        name: z.string().optional(),
        members: z.array(userRef).default([]),
        states: z
          .array(
            z.object({
              name: z.string().min(1),
              type: z.enum(["backlog", "unstarted", "started", "completed", "canceled", "triage"]),
            }),
          )
          .optional(),
        labels: z.array(z.string().min(1)).optional(),
      })
      .openapi("LinearTeamOptions"),
    response: LinearTeam,
    factory: { on: "LinearFixture", name: "createTeam", options: ["key", "name", "members", "states", "labels"] },
    stability,
    handler: async ({ session, body }) => {
      for (const member of body.members) person(session.id, member);
      return teamWire(await world.createTeam(session.id, body));
    },
  });

  router.route({
    method: "get",
    path: "/teams/{team}/issue",
    summary: "An issue of this team by its identifier (`ENG-12`)",
    params: z.object({ team: pathParam("team") }),
    query: z.object({ identifier: z.string().openapi({ param: { name: "identifier", in: "query", required: true } }) }),
    response: LinearIssue,
    errors: ["not_found"],
    sdkMethod: { on: "LinearTeam", name: "issue", args: ["identifier"] },
    stability,
    handler: ({ session, params, query }) => {
      const team = teamOf(session.id, params.team);
      const issue = store.issuesOf(team).find((candidate) => candidate.identifier === query.identifier);
      if (!issue) throw new ProtocolError("not_found", `${team.key} has no issue ${query.identifier}`);
      return issueWire(issue);
    },
  });

  // --- What people do: issues -------------------------------------------------------------------

  router.route({
    method: "post",
    path: "/users/{user}/issues",
    summary:
      "Create an issue. Sends `Issue` (`create`); with `delegate`, it opens an agent session and sends `AgentSessionEvent` (`created`)",
    params: UserParams,
    body: z
      .object({
        issue: z.object({
          title: z.string().min(1),
          description: z.string().optional(),
          priority: Priority.optional(),
          state: z.string().optional(),
          labels: z.array(z.string()).optional(),
          assignee: userRef.optional(),
          delegate: appRef.optional(),
          parent: issueRef.optional(),
        }),
        team: teamRef,
      })
      .openapi("LinearCreateIssueBody"),
    response: LinearIssue,
    errors: ["not_found", "forbidden"],
    sdkMethod: { on: "LinearUser", name: "createIssue", args: ["issue"], options: ["team"] },
    stability,
    handler: async ({ session, params, body }) => {
      const team = teamOf(session.id, body.team);
      const user = person(session.id, params.user);
      mayAct(user, team);
      const { issue } = body;
      if (issue.assignee) person(session.id, issue.assignee);
      if (issue.parent) issueOf(session.id, issue.parent);
      return issueWire(
        await asProtocol(() =>
          world.createIssue(team, user.id, {
            ...issue,
            description: issue.description === undefined ? undefined : world.markdown(session.id, issue.description),
            delegate: issue.delegate === undefined ? undefined : appOf(issue.delegate).userId,
          }),
        ),
      );
    },
  });

  /** One change to an issue as a person, through the one path the app's `issueUpdate` takes too. */
  const changeIssue = (
    name: string,
    summary: string,
    body: z.ZodObject<z.ZodRawShape>,
    options: { args: string[]; options: string[] },
    changes: (input: any, issue: LinearIssueRecord, session: string) => Parameters<LinearWorld["updateIssue"]>[2],
  ) =>
    router.route({
      method: "post",
      path: `/users/{user}/${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      summary,
      params: UserParams,
      body: body.openapi(`Linear${name.charAt(0).toUpperCase()}${name.slice(1)}Body`),
      response: LinearDelivery.nullable(),
      errors: ["not_found", "forbidden", "invalid_argument"],
      sdkMethod: { on: "LinearUser", name, ...options },
      stability,
      handler: async ({ session, params, body: input }) => {
        const issue = issueOf(session.id, (input as { issue: string }).issue);
        const user = actor(session.id, params.user, issue);
        const sent = await asProtocol(() => world.updateIssue(issue, user.id, changes(input, issue, session.id)));
        return caused(session.id, sent) ?? null;
      },
    });

  changeIssue(
    "editIssue",
    "Edit an issue's title, description or priority. Sends `Issue` (`update`)",
    z.object({
      changes: z.object({
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        priority: Priority.optional(),
      }),
      issue: issueRef,
    }),
    { args: ["changes"], options: ["issue"] },
    (input, _issue, session) => ({
      title: input.changes.title,
      description:
        input.changes.description === undefined ? undefined : world.markdown(session, input.changes.description),
      priority: input.changes.priority,
    }),
  );
  changeIssue(
    "undelegate",
    "Take an issue back from the app. Sends `Issue` (`update`)",
    z.object({ issue: issueRef }),
    { args: [], options: ["issue"] },
    () => ({ delegateId: null }),
  );
  changeIssue(
    "assign",
    "Assign an issue to a person, or (with no one) unassign it. Sends `Issue` (`update`)",
    z.object({ assignee: userRef.nullable().optional(), issue: issueRef }),
    { args: ["assignee"], options: ["issue"] },
    (input, _issue, session) => ({ assigneeId: input.assignee ? person(session, input.assignee).id : null }),
  );
  changeIssue(
    "setState",
    "Move an issue to a workflow state, by name. Sends `Issue` (`update`)",
    z.object({ state: z.string().min(1), issue: issueRef }),
    { args: ["state"], options: ["issue"] },
    (input, issue) => {
      const team = store.team(issue.team);
      const state = team.states.find((candidate) => candidate.name.toLowerCase() === input.state.toLowerCase());
      if (!state)
        throw new ProtocolError(
          "not_found",
          `${team.key} has no state "${input.state}". Its states: ${team.states.map((candidate) => candidate.name).join(", ")}`,
        );
      return { stateId: state.id };
    },
  );
  changeIssue(
    "label",
    "Put labels on an issue, by name. Sends `Issue` (`update`)",
    z.object({
      labels: z.array(z.string().min(1)).min(1).openapi({ "x-channelstack-one-or-many": true }),
      issue: issueRef,
    }),
    { args: ["labels"], options: ["issue"] },
    (input, issue) => {
      const team = store.team(issue.team);
      const ids = (input.labels as string[]).map((name) => {
        const label = team.labels.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
        if (!label)
          throw new ProtocolError(
            "not_found",
            `${team.key} has no label "${name}". Its labels: ${team.labels.map((candidate) => candidate.name).join(", ") || "none"}`,
          );
        return label.id;
      });
      return { labelIds: [...new Set([...issue.labels, ...ids])] };
    },
  );

  router.route({
    method: "post",
    path: "/users/{user}/delegate",
    summary:
      "Delegate an issue to an app. Opens that app's agent session and sends it `AgentSessionEvent` (`created`); an issue delegated to another app moves",
    params: UserParams,
    body: z.object({ app: appRef, issue: issueRef }).openapi("LinearDelegateBody"),
    response: LinearAgentSession,
    errors: ["not_found", "forbidden", "invalid_argument"],
    sdkMethod: { on: "LinearUser", name: "delegate", args: ["app"], options: ["issue"] },
    stability,
    handler: async ({ session, params, body }) => {
      const issue = issueOf(session.id, body.issue);
      const user = actor(session.id, params.user, issue);
      const app = appOf(body.app);
      if (issue.delegate === app.userId)
        throw new ProtocolError("invalid_argument", `${issue.identifier} is already delegated to ${app.name}`);
      await asProtocol(() => world.updateIssue(issue, user.id, { delegateId: app.userId }));
      const opened = store.sessionsOn(issue).at(-1) as LinearSessionRecord;
      return sessionWire(session.id, opened);
    },
  });

  // --- What people do: comments -----------------------------------------------------------------

  router.route({
    method: "post",
    path: "/users/{user}/comment",
    summary:
      "Comment on an issue. A mention of the app opens an agent session and sends `AgentSessionEvent` (`created`)",
    params: UserParams,
    body: z.object({ body: z.string().min(1), issue: issueRef }).openapi("LinearCommentBody"),
    response: LinearComment,
    errors: ["not_found", "forbidden"],
    sdkMethod: { on: "LinearUser", name: "comment", args: ["body"], options: ["issue"] },
    stability,
    handler: async ({ session, params, body }) => {
      const issue = issueOf(session.id, body.issue);
      const user = actor(session.id, params.user, issue);
      return commentWire(
        session.id,
        await asProtocol(() => world.comment(issue, user.id, world.markdown(session.id, body.body))),
      );
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/reply",
    summary:
      "Reply in a comment's thread. In an agent session's thread, it prompts the session (`AgentSessionEvent` `prompted`)",
    params: UserParams,
    body: z.object({ body: z.string().min(1), comment: commentRef }).openapi("LinearReplyBody"),
    response: LinearComment,
    errors: ["not_found", "forbidden"],
    sdkMethod: { on: "LinearUser", name: "reply", args: ["body"], options: ["comment"] },
    stability,
    handler: async ({ session, params, body }) => {
      const parent = commentOf(session.id, body.comment);
      const issue = store.issue(parent.issue);
      const user = actor(session.id, params.user, issue);
      return commentWire(
        session.id,
        await asProtocol(() => world.comment(issue, user.id, world.markdown(session.id, body.body), parent)),
      );
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/edit",
    summary: "Edit a comment. Sends `Comment` (`update`)",
    params: UserParams,
    body: z.object({ body: z.string().min(1), comment: commentRef }).openapi("LinearEditBody"),
    response: LinearDelivery.nullable(),
    errors: ["not_found", "forbidden"],
    sdkMethod: { on: "LinearUser", name: "edit", args: ["body"], options: ["comment"] },
    stability,
    handler: async ({ session, params, body }) => {
      const comment = commentOf(session.id, body.comment);
      const user = actor(session.id, params.user, store.issue(comment.issue));
      if (comment.user !== user.id && !user.admin)
        throw new ProtocolError(
          { platform: "forbidden", status: 409 },
          "Only its author or an admin can edit a comment",
        );
      return (
        caused(
          session.id,
          await asProtocol(() => world.editComment(comment, user.id, world.markdown(session.id, body.body))),
        ) ?? null
      );
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/delete",
    summary: "Delete a comment. Sends `Comment` (`remove`)",
    params: UserParams,
    body: z.object({ comment: commentRef }).openapi("LinearDeleteBody"),
    response: LinearDelivery.nullable(),
    errors: ["not_found", "forbidden"],
    sdkMethod: { on: "LinearUser", name: "delete", options: ["comment"] },
    stability,
    handler: async ({ session, params, body }) => {
      const comment = commentOf(session.id, body.comment);
      const user = actor(session.id, params.user, store.issue(comment.issue));
      if (comment.user !== user.id && !user.admin)
        throw new ProtocolError(
          { platform: "forbidden", status: 409 },
          "Only its author or an admin can delete a comment",
        );
      return caused(session.id, await world.deleteComment(comment, user.id)) ?? null;
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/react",
    summary: "React to a comment with an emoji. Linear sends no webhook for it",
    params: UserParams,
    body: z.object({ emoji: z.string().min(1), comment: commentRef }).openapi("LinearReactBody"),
    errors: ["not_found", "forbidden"],
    sdkMethod: { on: "LinearUser", name: "react", args: ["emoji"], options: ["comment"] },
    stability,
    handler: async ({ session, params, body }) => {
      const comment = commentOf(session.id, body.comment);
      const user = actor(session.id, params.user, store.issue(comment.issue));
      await world.react(comment, user.id, body.emoji.replace(/^:|:$/g, ""));
    },
  });

  // --- What people do: agent sessions -----------------------------------------------------------

  /** A person's turn in a session goes into its thread, where it has one, as a reply. */
  const turn = async (session: string, userId: string, record: LinearSessionRecord, text: string) => {
    await world.refresh(session, { issue: record.issue });
    const issue = store.issue(record.issue);
    const user = actor(session, userId, issue);
    const body = world.markdown(session, text);
    // In a session's thread (its mention, or the one Linear opens for a delegation), the prompt is a
    // reply; a live session whose thread the mirror hasn't read yet takes it directly.
    const root = record.thread === null ? undefined : store.comments.find(record.thread);
    if (root) return caused(session, (await world.comment(issue, user.id, body, root)).prompted);
    return caused(session, await world.promptSession(record, user.id, body));
  };

  router.route({
    method: "post",
    path: "/users/{user}/prompt",
    summary: "Send a follow-up in an agent session. Sends `AgentSessionEvent` (`prompted`)",
    params: UserParams,
    body: z.object({ body: z.string().min(1), session: sessionRef }).openapi("LinearPromptBody"),
    // The prompt's delivery; none live, where Linear delivers to the agent itself.
    response: LinearDelivery.nullable(),
    errors: ["not_found", "forbidden"],
    sdkMethod: { on: "LinearUser", name: "prompt", args: ["body"], options: ["session"] },
    stability,
    handler: async ({ session, params, body }) =>
      (await turn(session.id, params.user, sessionOf(session.id, body.session), body.body)) ?? null,
  });

  router.route({
    method: "post",
    path: "/users/{user}/answer",
    summary: "Answer a question the agent asked (an `elicitation` activity). Sends `AgentSessionEvent` (`prompted`)",
    params: UserParams,
    body: z.object({ body: z.string().min(1), elicitation: activityRef }).openapi("LinearAnswerBody"),
    // The answer's delivery; none live, where Linear delivers to the agent itself.
    response: LinearDelivery.nullable(),
    errors: ["not_found", "forbidden", "invalid_argument"],
    sdkMethod: { on: "LinearUser", name: "answer", args: ["body"], options: ["elicitation"] },
    stability,
    handler: async ({ session, params, body }) => {
      const elicitation = activityOf(session.id, body.elicitation);
      if (elicitation.content.type !== "elicitation")
        throw new ProtocolError(
          "invalid_argument",
          `That activity is a ${elicitation.content.type}, not an elicitation`,
        );
      return (
        (await turn(
          session.id,
          params.user,
          store.sessions.find(elicitation.session) as LinearSessionRecord,
          body.body,
        )) ?? null
      );
    },
  });

  router.route({
    method: "post",
    path: "/users/{user}/stop",
    summary: "Press Stop on an agent session. Sends `AgentSessionEvent` (`prompted`) with the `stop` signal",
    params: UserParams,
    body: z.object({ session: sessionRef }).openapi("LinearStopBody"),
    response: LinearDelivery,
    errors: ["not_found", "forbidden"],
    sdkMethod: { on: "LinearUser", name: "stop", options: ["session"] },
    live: IN_THE_UI,
    stability,
    handler: ({ session, params, body }) => {
      const record = sessionOf(session.id, body.session);
      const user = actor(session.id, params.user, store.issue(record.issue));
      const sent = caused(session.id, fake.stop(record, user.id));
      if (!sent) throw new Error("Stop always reaches the agent's webhook");
      return sent;
    },
  });

  // --- Reading an issue -------------------------------------------------------------------------

  const issueRead = <R extends z.ZodType>(
    path: string,
    name: string,
    summary: string,
    response: R,
    read: (issue: LinearIssueRecord, session: string) => z.input<R>,
    extra: { waits?: Parameters<DriverRouter["route"]>[0]["waits"]; onceQuiet?: boolean; retryWhile?: string[] } = {},
  ) =>
    router.route({
      method: "get",
      path: `/issues/{issue}${path}`,
      summary,
      params: IssueParams,
      response,
      errors: ["not_found"],
      sdkMethod: {
        on: "LinearIssue",
        name,
        ...(extra.onceQuiet ? { onceQuiet: true } : {}),
        ...(extra.retryWhile ? { retryWhile: extra.retryWhile } : {}),
      },
      ...(extra.waits ? { waits: extra.waits } : {}),
      stability,
      handler: async ({ session, params }) => {
        const issue = issueOf(session.id, params.issue);
        await world.refresh(session.id, { issue: issue.id });
        return read(issue, session.id) as never;
      },
    });

  issueRead("", "refresh", "Read the issue again", LinearIssue, issueWire);
  issueRead("/title", "title", "The issue's title as it is now", z.string(), (issue) => issue.title);
  issueRead(
    "/state",
    "state",
    "The issue's workflow state",
    z
      .object({
        name: z.string(),
        type: z.enum(["backlog", "unstarted", "started", "completed", "canceled", "triage", "duplicate"]),
      })
      .openapi("LinearIssueState"),
    (issue) => {
      const { name, type } = world.stateOf(issue);
      return { name, type };
    },
  );
  issueRead("/assignee", "assignee", "Who the issue is assigned to, if anyone", LinearUser.nullable(), (issue) =>
    issue.assignee === null ? null : userWire(store.user(issue.assignee) as LinearUserRecord),
  );
  issueRead("/delegate", "delegatedTo", "The app the issue is delegated to, if any", LinearApp.nullable(), (issue) =>
    issue.delegate === null ? null : appWire(store.appByUser(issue.delegate)),
  );
  issueRead("/labels", "labels", "The names of the labels on the issue", z.array(z.string()), (issue) => {
    const team = store.team(issue.team);
    return team.labels.filter((label) => issue.labels.includes(label.id)).map((label) => label.name);
  });
  issueRead(
    "/comments",
    "comments",
    "The comments on the issue, oldest first, without the one Linear writes to open a delegated session's thread",
    z.array(LinearComment).openapi("LinearComments"),
    (issue, session) =>
      store
        .commentsOn(issue)
        .filter((comment) => !comment.byLinear)
        .map((comment) => commentWire(session, comment)),
    {
      waits: [
        { name: "waitForComment", mode: "next", from: "author", text: "body", what: "a comment" },
        { name: "latestComment", mode: "latest", from: "author", what: "a comment" },
      ],
    },
  );
  issueRead(
    "/sessions",
    "sessions",
    "The agent sessions on the issue, oldest first",
    z.array(LinearAgentSession).openapi("LinearAgentSessions"),
    (issue, session) => store.sessionsOn(issue).map((record) => sessionWire(session, record)),
  );
  issueRead(
    "/session",
    "session",
    "The issue's latest agent session, waiting for one to be opened",
    LinearAgentSession,
    (issue, session) => {
      const latest = store.sessionsOn(issue).at(-1);
      if (!latest) throw new ProtocolError("not_found", `No agent session on ${issue.identifier} yet`);
      return sessionWire(session, latest);
    },
    { retryWhile: ["not_found"] },
  );
  issueRead(
    "/transcript",
    "transcript",
    "The issue as a person reads it: description, comments and the agent's sessions",
    LinearTranscript,
    (issue) =>
      renderTranscript(
        {
          issue,
          comments: store.commentsOn(issue),
          sessions: store.sessionsOn(issue),
          activities: (record) => store.activitiesOf(record),
        },
        { principal, readable: world.readable },
      ),
  );

  // --- Reading a comment and a session ----------------------------------------------------------

  router.route({
    method: "get",
    path: "/comments/{comment}/replies",
    summary: "The replies in a comment's thread, once the agent is quiet",
    params: CommentParams,
    response: z.array(LinearComment).openapi("LinearCommentReplies"),
    errors: ["not_found"],
    sdkMethod: { on: "LinearComment", name: "replies", onceQuiet: true },
    stability,
    handler: async ({ session, params }) => {
      await world.refresh(session.id, { issue: commentOf(session.id, params.comment).issue });
      const root = world.rootOf(commentOf(session.id, params.comment));
      return store
        .commentsOn(store.issue(root.issue))
        .filter((comment) => comment.parent === root.id)
        .map((comment) => commentWire(session.id, comment));
    },
  });

  router.route({
    method: "get",
    path: "/comments/{comment}/delivery-for",
    summary:
      "The `Comment` (`create`) delivery this comment caused to this app (decision 0027), or nothing when it wasn't told. The comment's `delivery` is the built-in app's",
    params: CommentParams,
    query: z.object({ app: z.string().openapi({ param: { name: "app", in: "query" }, ...refTo("LinearApp") }) }),
    response: LinearDelivery.nullable(),
    errors: ["not_found"],
    sdkMethod: { on: "LinearComment", name: "deliveryFor", args: ["app"] },
    live: DELIVERY_IS_THE_PLATFORMS,
    stability,
    handler: ({ session, params, query }) => {
      const comment = commentOf(session.id, params.comment);
      const app = appOf(query.app);
      const found = fake.deliveries(session.id).find(({ request }) => {
        const payload = request.meta?.payload as { action?: string; data?: { id?: string } } | undefined;
        return (
          (request.app ?? BUILT_IN_APP) === app.name &&
          request.type === "Comment" &&
          payload?.action === "create" &&
          payload.data?.id === comment.id
        );
      });
      return found ? deliveryWire(found) : null;
    },
  });

  router.route({
    method: "get",
    path: "/comments/{comment}/transcript",
    summary: "A comment's thread as a person reads it",
    params: CommentParams,
    response: LinearTranscript,
    errors: ["not_found"],
    sdkMethod: { on: "LinearComment", name: "transcript" },
    stability,
    handler: async ({ session, params }) => {
      await world.refresh(session.id, { issue: commentOf(session.id, params.comment).issue });
      const root = world.rootOf(commentOf(session.id, params.comment));
      const issue = store.issue(root.issue);
      const thread = store.commentsOn(issue).filter((comment) => comment.id === root.id || comment.parent === root.id);
      return renderTranscript(
        {
          comments: thread,
          sessions: store.sessionsOn(issue).filter((record) => record.thread === root.id),
          activities: (record) => store.activitiesOf(record),
        },
        { principal, readable: world.readable },
      );
    },
  });

  const sessionRead = <R extends z.ZodType>(
    path: string,
    name: string,
    summary: string,
    response: R,
    read: (record: LinearSessionRecord, session: string) => z.input<R>,
    extra: { waits?: Parameters<DriverRouter["route"]>[0]["waits"] } = {},
  ) =>
    router.route({
      method: "get",
      path: `/agent-sessions/{agentSession}${path}`,
      summary,
      params: SessionParams,
      response,
      errors: ["not_found"],
      sdkMethod: { on: "LinearAgentSession", name },
      ...(extra.waits ? { waits: extra.waits } : {}),
      stability,
      handler: async ({ session, params }) => {
        const record = sessionOf(session.id, params.agentSession);
        await world.refresh(session.id, { agentSession: record.id });
        return read(sessionOf(session.id, params.agentSession), session.id) as never;
      },
    });

  sessionRead("/state", "state", "The session's status", SessionState, (record) => record.status, {
    waits: [{ name: "waitForState", mode: "until", in: true, what: "the agent session to reach that state" }],
  });
  sessionRead(
    "/activities",
    "activities",
    "The session's activities, oldest first: the agent's, and the prompts of people",
    z.array(LinearAgentActivity).openapi("LinearAgentActivities"),
    (record, session) => store.activitiesOf(record).map((activity) => activityWire(session, activity)),
    {
      waits: [
        // What the agent says after a person's prompt answers that prompt, not an earlier one.
        {
          name: "waitForActivity",
          mode: "next",
          text: "type",
          turn: { field: "type", value: "prompt" },
          what: "an activity",
        },
      ],
    },
  );
  sessionRead(
    "/external-urls",
    "externalUrls",
    "The links the agent attached to the session",
    z.array(z.object({ label: z.string(), url: z.string() })).openapi("LinearExternalUrls"),
    (record) => record.externalUrls.map((entry) => ({ ...entry })),
  );
  sessionRead(
    "/plan",
    "plan",
    "The agent's plan: each step and its status",
    z
      .array(z.object({ content: z.string(), status: z.enum(["pending", "inProgress", "completed", "canceled"]) }))
      .openapi("LinearPlan"),
    (record) => (record.plan?.entries ?? []).map((entry) => ({ ...entry })),
  );
  sessionRead("/transcript", "transcript", "The session as a person reads it", LinearTranscript, (record) =>
    renderTranscript(
      { comments: [], sessions: [record], activities: (entry) => store.activitiesOf(entry) },
      { principal, readable: world.readable },
    ),
  );

  // --- Deliveries and calls ---------------------------------------------------------------------

  registerInspectionRoutes(router, {
    title: "Linear",
    events: deps.events,
    stability,
    deliveries: fake,
    delivery: { schema: LinearDelivery, wire: deliveryWire },
    listSummary: "Every webhook channelstack sent the agent for this session, with every attempt",
    filters: {
      type: "Only this resource type, e.g. `AgentSessionEvent`.",
      resource: {
        description: "Only deliveries about this issue.",
        ref: "LinearIssue",
        matches: ({ request }, issue) => request.meta?.issue === issue,
      },
    },
    live: { redeliver: NO_REDELIVERY },
    redeliver: {
      summary: "Redeliver, as Linear retries: the same delivery, with a new `webhookTimestamp` and a new signature",
    },
    resend: {
      summary:
        "Send the delivery again: stale (its `webhookTimestamp` two minutes old), or signed with a secret that isn't the app's",
      options: ["badSignature", "stale"],
    },
    calls: {
      schema: LinearApiCall,
      summary:
        "The GraphQL operations the agent sent about this session's issues and sessions, by root field (`agentActivityCreate`)",
      live: AGENT_SIDE,
    },
  });
}
