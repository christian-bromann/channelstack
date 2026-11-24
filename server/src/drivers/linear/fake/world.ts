import type { RetryPolicy } from "../../../core/delivery/index.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import { ID_FORMATS } from "../../../core/ids/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { randomToken } from "../../../core/secrets/index.ts";
import { signLinearWebhook, stampLinearWebhook } from "../../../core/signing/linear.ts";
import { linearLinks } from "../links.ts";
import { linearPayloads } from "../payloads.ts";
import { linearText } from "../text.ts";
import type {
  LinearActivityRecord,
  LinearActivityType,
  LinearCommentRecord,
  LinearIssueChanges,
  LinearIssueInput,
  LinearIssueRecord,
  LinearLabelRecord,
  LinearPlanEntry,
  LinearSessionRecord,
  LinearStateRecord,
  LinearStateType,
  LinearTeamRecord,
  LinearUserRecord,
} from "../world.ts";
import { LinearError, notFound } from "./graphql.ts";
import type { LinearStore } from "./store.ts";

/** Linear waits five seconds for a webhook to be answered. */
const ACK_WINDOW_MS = 5_000;
/** Linear retries a webhook that wasn't answered with a 2xx: after a minute, an hour, six hours. */
const RETRY_DELAYS_MS = [60_000, 3_600_000, 21_600_000];
const LINEAR_RETRIES: RetryPolicy = {
  next(_attempt, retries) {
    const afterMs = RETRY_DELAYS_MS[retries];
    return afterMs === undefined ? undefined : { afterMs, headers: {} };
  },
};

/** A new team's workflow, as Linear sets one up. */
const DEFAULT_STATES: ReadonlyArray<readonly [string, LinearStateType, string]> = [
  ["Backlog", "backlog", "#bec2c8"],
  ["Todo", "unstarted", "#e2e2e2"],
  ["In Progress", "started", "#f2c94c"],
  ["In Review", "started", "#0f783c"],
  ["Done", "completed", "#5e6ad2"],
  ["Canceled", "canceled", "#95a2b3"],
];
const STATE_COLOR: Readonly<Record<LinearStateType, string>> = {
  triage: "#fc7840",
  backlog: "#bec2c8",
  unstarted: "#e2e2e2",
  started: "#f2c94c",
  completed: "#5e6ad2",
  canceled: "#95a2b3",
};

/**
 * The fake Linear world: every change to the state happens here once, for people (through the
 * control API) and for the app (through GraphQL) alike. The caller brings the permission check.
 */
export function createFakeWorld(context: DriverContext, store: LinearStore) {
  const { ids, clock, delivery } = context;
  const links = linearLinks(context.apiUrl, () => store.org);
  const { userOf, markdown, mentioned, readable, rootOf, stateOf } = linearText(store, links, (session, name) => {
    if (name.toLowerCase() === store.appUser.displayName.toLowerCase()) return store.appUser.id;
    return store.list(store.users, session).find((user) => user.displayName.toLowerCase() === name.toLowerCase())?.id;
  });
  const payloads = linearPayloads({
    links,
    user: userOf,
    team: (id) => store.team(id),
    issue: (id) => store.issue(id),
    comment: (id) => store.comments.find(id),
    state: (issue) => stateOf(issue),
  });

  /** Linear's headers for one delivery, signed with this secret over each attempt's body. */
  const signedWith = (secret: string, id: string, type: string) => (body: string, atMs: number) => ({
    "linear-delivery": id,
    "linear-event": type,
    "user-agent": "Linear-Webhook",
    ...signLinearWebhook(secret, body, atMs),
  });

  /**
   * Send a webhook to the app, if it is subscribed to this resource type and has a URL. The body
   * carries `webhookTimestamp`, which every attempt stamps and signs again.
   */
  const emit = (session: string, type: string, payload: Record<string, unknown>): string | undefined => {
    if (!store.app.events.includes(type)) return undefined;
    // An agent session is always announced: an agent's webhook is part of its app, so a session has a
    // delivery even where nothing listens (it is then unreachable). Other events need a URL to go to.
    if (context.webhookUrl === undefined && type !== "AgentSessionEvent") return undefined;
    const id = ids.next("linear.uuid");
    const full = {
      ...payload,
      type,
      organizationId: store.org.id,
      webhookId: store.app.webhookId,
      webhookTimestamp: clock(),
    };
    delivery.enqueue({
      id,
      session,
      driver: "linear",
      type,
      url: context.webhookUrl ?? "",
      body: JSON.stringify(full),
      stamp: stampLinearWebhook,
      sign: signedWith(context.secret("webhookSecret"), id, type),
      timeoutMs: ACK_WINDOW_MS,
      retry: LINEAR_RETRIES,
      meta: {
        eventType: typeof payload.action === "string" ? `${type}.${payload.action}` : type,
        action: payload.action,
        payload: full,
        issue: issueOfPayload(type, payload),
      },
    });
    return id;
  };
  /** The issue a webhook is about, so a test can ask for the deliveries of one. */
  const issueOfPayload = (type: string, payload: Record<string, unknown>): string | undefined => {
    const data = (payload.data ?? payload.agentSession) as { issueId?: string; id?: string } | undefined;
    return data?.issueId ?? (type === "Issue" ? data?.id : undefined);
  };

  const entityEvent = (
    session: string,
    type: "Issue" | "Comment",
    action: "create" | "update" | "remove",
    actor: string,
    data: Record<string, unknown>,
    url: string,
    updatedFrom?: Record<string, unknown>,
  ) =>
    emit(session, type, {
      action,
      actor: payloads.actor(userOf(actor)),
      createdAt: new Date(clock()).toISOString(),
      data,
      url,
      ...(updatedFrom ? { updatedFrom } : {}),
    });

  // --- Text -------------------------------------------------------------------------------------

  // --- Sessions ---------------------------------------------------------------------------------

  /** A session's issue, with its context as Linear writes it for a prompt. */
  const promptContext = (issue: LinearIssueRecord, comment: LinearCommentRecord | undefined): string => {
    const team = store.team(issue.team);
    const lines = [
      `<issue identifier="${issue.identifier}">`,
      `<title>${issue.title}</title>`,
      ...(issue.description ? [`<description>${issue.description}</description>`] : []),
      `<team name="${team.name}"/>`,
      `</issue>`,
    ];
    if (comment) {
      const author = userOf(comment.user);
      lines.push(
        `<primary-directive-thread comment-id="${comment.id}">`,
        `<comment author="${author.displayName}">${comment.body}</comment>`,
        `</primary-directive-thread>`,
      );
    }
    return lines.join("\n");
  };

  /** Open an agent session on an issue for the app, and tell it. */
  const startSession = (issue: LinearIssueRecord, creator: string, comment: LinearCommentRecord | undefined) => {
    const session = store.sessionOf(issue);
    const now = clock();
    const record = store.add(store.sessions, session, {
      id: ids.next("linear.uuid"),
      issue: issue.id,
      appUser: store.appUser.id,
      creator,
      comment: comment ? rootOf(comment).id : null,
      thread: comment ? rootOf(comment).id : null,
      status: "pending",
      plan: null,
      externalUrls: [],
      summary: null,
      slugId: ids.next("linear.slugId"),
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      endedAt: null,
      delivery: undefined,
    } satisfies LinearSessionRecord);
    if (comment) comment.session = record.id;
    // Delegating is the person's first turn: Linear records it as a prompt, "Work on [ENG-1](url)",
    // before the agent says anything (the differential run found it against the real workspace).
    if (!comment) {
      store.add(store.activities, session, {
        id: ids.next("linear.uuid"),
        session: record.id,
        user: creator,
        content: { type: "prompt", body: `Work on [${issue.identifier}](${links.issue(issue)})` },
        ephemeral: false,
        signal: null,
        signalMetadata: null,
        sourceComment: null,
        createdAt: now,
      } satisfies LinearActivityRecord);
    }
    const previous = comment
      ? store
          .commentsOn(issue)
          .filter((other) => rootOf(other).id === rootOf(comment).id && other.createdAt < comment.createdAt)
      : [];
    record.delivery = emit(session, "AgentSessionEvent", {
      action: "created",
      createdAt: new Date(now).toISOString(),
      appUserId: store.appUser.id,
      oauthClientId: context.secret("clientId"),
      agentSession: payloads.session(record, store.org.id),
      promptContext: promptContext(issue, comment),
      previousComments: previous.map(payloads.commentChild),
      guidance: [],
    });
    return record;
  };

  /** Move a session to a status, keeping Linear's times: `startedAt` when it becomes active, `endedAt` when it completes. */
  const moveTo = (record: LinearSessionRecord, status: LinearSessionRecord["status"]) => {
    const now = clock();
    if (status === "active" && record.status !== "active") record.startedAt = now;
    if (status === "complete") record.endedAt = now;
    if (status === "active" || status === "pending" || status === "stopping") record.endedAt = null;
    // Entering error or stale clears the plan.
    if (status === "error" || status === "stale") record.plan = null;
    record.status = status;
    record.updatedAt = now;
  };

  /**
   * A person's turn in a session: a prompt, an answer, or Stop. Linear records it as a `prompt`
   * activity and sends `AgentSessionEvent` (`prompted`).
   */
  const promptSession = (
    record: LinearSessionRecord,
    user: string,
    body: string,
    options: { signal?: "stop"; comment?: LinearCommentRecord } = {},
  ) => {
    const session = store.sessions.owner(record.id);
    if (session === undefined) throw new Error("A session belongs to a test session");
    const activity = store.add(store.activities, session, {
      id: ids.next("linear.uuid"),
      session: record.id,
      user,
      content: { type: "prompt", body },
      ephemeral: false,
      signal: options.signal ?? null,
      signalMetadata: null,
      sourceComment: options.comment?.id ?? null,
      createdAt: clock(),
    } satisfies LinearActivityRecord);
    // A new turn makes the session wait for the agent again; Stop asks it to stop.
    moveTo(record, options.signal === "stop" ? "stopping" : "pending");
    return emit(session, "AgentSessionEvent", {
      action: "prompted",
      createdAt: new Date(clock()).toISOString(),
      appUserId: store.appUser.id,
      oauthClientId: context.secret("clientId"),
      agentSession: payloads.session(record, store.org.id),
      agentActivity: payloads.activity(activity),
    });
  };

  // --- Issues -----------------------------------------------------------------------------------

  const stateNamed = (team: LinearTeamRecord, name: string): LinearStateRecord => {
    const state = team.states.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!state) {
      throw new ProtocolError(
        "not_found",
        `${team.key} has no state "${name}". Its states: ${team.states.map((candidate) => candidate.name).join(", ")}`,
      );
    }
    return state;
  };

  const labelsNamed = (team: LinearTeamRecord, names: readonly string[]): LinearLabelRecord[] =>
    names.map((name) => {
      const label = team.labels.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
      if (!label) {
        throw new ProtocolError(
          "not_found",
          `${team.key} has no label "${name}". Its labels: ${team.labels.map((candidate) => candidate.name).join(", ") || "none"}`,
        );
      }
      return label;
    });

  /** Move an issue to a state, keeping the times Linear keeps for it. */
  const enterState = (issue: LinearIssueRecord, state: LinearStateRecord) => {
    const now = clock();
    issue.state = state.id;
    if (state.type === "started" && issue.startedAt === null) issue.startedAt = now;
    issue.completedAt = state.type === "completed" ? now : null;
    issue.canceledAt = state.type === "canceled" ? now : null;
  };

  /**
   * Change an issue, as `issueUpdate` does. Everything is checked before anything changes; one
   * `Issue` (`update`) event names what was there before. A new delegate is a new agent session.
   */
  const updateIssue = (issue: LinearIssueRecord, actor: string, changes: LinearIssueChanges) => {
    const team = store.team(issue.team);
    const state =
      changes.stateId === undefined ? undefined : team.states.find((candidate) => candidate.id === changes.stateId);
    if (changes.stateId !== undefined && !state) throw notFound("WorkflowState");
    for (const label of changes.labelIds ?? [])
      if (!team.labels.some((candidate) => candidate.id === label)) throw notFound("IssueLabel");
    for (const id of [changes.assigneeId, changes.delegateId]) if (id && !store.user(id)) throw notFound("User");
    if (changes.delegateId && changes.delegateId !== store.appUser.id) {
      throw new LinearError("Only an agent can be delegated an issue", "INPUT_ERROR", "invalid input");
    }
    if (
      changes.priority !== undefined &&
      (changes.priority < 0 || changes.priority > 4 || !Number.isInteger(changes.priority))
    ) {
      throw new LinearError("priority must be an integer from 0 to 4");
    }
    const updatedFrom: Record<string, unknown> = {};
    const set = <K extends keyof LinearIssueRecord>(key: K, from: string, value: LinearIssueRecord[K] | undefined) => {
      if (value === undefined || JSON.stringify(issue[key]) === JSON.stringify(value)) return;
      updatedFrom[from] = issue[key];
      issue[key] = value;
    };
    set("title", "title", changes.title);
    set("description", "description", changes.description === "" ? null : changes.description);
    set("priority", "priority", changes.priority);
    set("labels", "labelIds", changes.labelIds === undefined ? undefined : [...changes.labelIds]);
    set("assignee", "assigneeId", changes.assigneeId);
    const delegated =
      changes.delegateId !== undefined && changes.delegateId !== issue.delegate && changes.delegateId !== null;
    set("delegate", "delegateId", changes.delegateId);
    if (state && state.id !== issue.state) {
      updatedFrom.stateId = issue.state;
      enterState(issue, state);
    }
    if (Object.keys(updatedFrom).length === 0) return undefined;
    issue.updatedAt = clock();
    updatedFrom.updatedAt = new Date(issue.updatedAt).toISOString();
    const session = store.sessionOf(issue);
    const sent = entityEvent(session, "Issue", "update", actor, payloads.issue(issue), links.issue(issue), updatedFrom);
    if (delegated) startSession(issue, actor, undefined);
    return sent;
  };

  // --- Comments ---------------------------------------------------------------------------------

  /**
   * Write a comment, as a person or the app. A person mentioning the app opens a session; a
   * person replying in a session's thread prompts that session.
   */
  const comment = (issue: LinearIssueRecord, user: string, body: string, parent?: LinearCommentRecord) => {
    if (body.trim() === "") throw new LinearError("body must not be empty");
    const session = store.sessionOf(issue);
    const root = parent ? rootOf(parent) : undefined;
    const now = clock();
    const record = store.add(store.comments, session, {
      id: ids.next("linear.uuid"),
      issue: issue.id,
      user,
      body,
      parent: root?.id ?? null,
      reactions: [],
      createdAt: now,
      updatedAt: now,
      editedAt: null,
      session: undefined,
      delivery: undefined,
      prompted: undefined,
    } satisfies LinearCommentRecord);
    issue.updatedAt = now;
    record.delivery = entityEvent(
      session,
      "Comment",
      "create",
      user,
      payloads.comment(record),
      links.comment(issue, record.id),
    );
    if (user === store.appUser.id) return record;
    const thread = root ? store.sessionsOn(issue).find((candidate) => candidate.thread === root.id) : undefined;
    if (thread) {
      record.session = thread.id;
      record.prompted = promptSession(thread, user, body, { comment: record });
    } else if (mentioned(body).includes(store.appUser.id)) {
      startSession(issue, user, record);
    }
    return record;
  };

  // --- Activities -------------------------------------------------------------------------------

  /**
   * An id the app chose for what it creates (`agentActivityCreate`'s `id`, so a retry can't make a
   * second one): a UUID nothing has yet. One that is taken is refused, never overwritten.
   */
  const claimId = (id: string): string => {
    try {
      return ids.reserve("linear.uuid", id);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      throw new LinearError(/already in use/.test(error.message) ? "Entity already exists" : "id must be a UUID");
    }
  };

  /**
   * The app publishes an activity, as `agentActivityCreate` does: checked first, then the session
   * moves on. A thought or an action makes it active, an elicitation waits for input, a response
   * completes the turn (unless it has the `continue` signal), an error is the error state.
   */
  const publish = (
    record: LinearSessionRecord,
    input: {
      content: Record<string, unknown>;
      ephemeral?: boolean | null;
      signal?: string | null;
      signalMetadata?: Record<string, unknown> | null;
      id?: string | null;
    },
  ): LinearActivityRecord => {
    const type = input.content.type as LinearActivityType | undefined;
    const text = (name: string) =>
      typeof input.content[name] === "string" ? (input.content[name] as string) : undefined;
    if (type === undefined || !["thought", "action", "elicitation", "response", "error"].includes(type)) {
      throw new LinearError(
        type === "prompt"
          ? "Only a user can publish a prompt activity"
          : `content.type must be one of thought, action, elicitation, response, error`,
      );
    }
    if (
      type === "action"
        ? text("action") === undefined || text("parameter") === undefined
        : (text("body") ?? "").trim() === ""
    ) {
      throw new LinearError(type === "action" ? "An action needs action and parameter" : `A ${type} needs a body`);
    }
    if (input.ephemeral && type !== "thought" && type !== "action")
      throw new LinearError("Only thought and action activities can be ephemeral");
    const signal = input.signal ?? null;
    if (signal === "stop") throw new LinearError("The stop signal is reserved for users");
    if (signal === "continue" && type !== "response") throw new LinearError("Use continue only with a response");
    if ((signal === "auth" || signal === "select") && type !== "elicitation")
      throw new LinearError(`Use ${signal} only with an elicitation`);
    if (record.status === "stale") throw new LinearError("The session is stale");
    const session = store.sessions.owner(record.id);
    if (session === undefined) throw new Error("A session belongs to a test session");
    const activity = store.add(store.activities, session, {
      id: input.id ? claimId(input.id) : ids.next("linear.uuid"),
      session: record.id,
      user: store.appUser.id,
      content:
        type === "action"
          ? { type, action: text("action") ?? "", parameter: text("parameter") ?? "", result: text("result") ?? null }
          : type === "error"
            ? { type, body: text("body") ?? "", reason: text("reason") ?? null }
            : { type, body: text("body") ?? "" },
      ephemeral: input.ephemeral === true,
      signal: signal as LinearActivityRecord["signal"],
      signalMetadata: input.signalMetadata ?? null,
      sourceComment: null,
      createdAt: clock(),
    } satisfies LinearActivityRecord);
    const next: Record<string, LinearSessionRecord["status"]> = {
      thought: "active",
      action: "active",
      elicitation: "awaitingInput",
      response: signal === "continue" ? "active" : "complete",
      error: "error",
    };
    // Stopping, a thought doesn't undo the Stop: only the turn's end (a response or an error) does.
    const status = next[type] ?? "active";
    if (!(record.status === "stopping" && status === "active")) moveTo(record, status);
    // What the person has to read (an answer, a question, a failure) Linear also writes as a
    // comment of the app in the session's thread; the activity's source comment is that comment.
    if (type === "response" || type === "elicitation" || type === "error") {
      const issue = store.issue(record.issue);
      const parent = record.thread === null ? undefined : store.commentsOn(issue).find((c) => c.id === record.thread);
      const written = comment(issue, store.appUser.id, activity.content.body ?? "", parent);
      written.session = record.id;
      record.thread ??= written.id;
      activity.sourceComment = written.id;
    }
    return activity;
  };

  /** The app updates its session: a title, links, a plan. Anything but a title acknowledges a pending session. */
  const updateSession = (
    record: LinearSessionRecord,
    input: {
      summary?: string | null;
      plan?: unknown;
      externalUrls?: Array<{ label: string; url: string }> | null;
      addedExternalUrls?: Array<{ label: string; url: string }> | null;
      removedExternalUrls?: string[] | null;
      externalLink?: string | null;
    },
  ) => {
    const urls = [...(input.externalUrls ?? []), ...(input.addedExternalUrls ?? [])];
    for (const { url } of urls)
      if (!/^https?:\/\//.test(url)) throw new LinearError("External URLs must use HTTP or HTTPS");
    if (input.externalUrls && (input.addedExternalUrls || input.removedExternalUrls)) {
      throw new LinearError("externalUrls can't be combined with addedExternalUrls or removedExternalUrls");
    }
    let plan: LinearSessionRecord["plan"] | undefined;
    if (input.plan !== undefined) {
      if (input.plan === null) plan = null;
      else {
        const entries = input.plan as Array<{ content?: unknown; status?: unknown }>;
        const statuses = ["pending", "inProgress", "completed", "canceled"];
        const valid =
          Array.isArray(entries) &&
          entries.length >= 1 &&
          entries.length <= 100 &&
          entries.every(
            (entry) =>
              Object.keys(entry).every((key) => key === "content" || key === "status") &&
              typeof entry.content === "string" &&
              entry.content.length >= 1 &&
              entry.content.length <= 10_000 &&
              statuses.includes(String(entry.status)),
          );
        if (!valid) throw new LinearError("plan must be a list of 1 to 100 entries, each with content and status");
        plan = { entries: entries as LinearPlanEntry[], updatedAt: clock() };
      }
    }
    if (input.summary !== undefined) record.summary = input.summary;
    // Non-null plan updates are ignored while the session is in its error state.
    if (plan !== undefined && !(plan !== null && record.status === "error")) record.plan = plan;
    if (input.externalUrls) record.externalUrls = input.externalUrls.map(({ label, url }) => ({ label, url }));
    if (input.removedExternalUrls)
      record.externalUrls = record.externalUrls.filter((entry) => !input.removedExternalUrls?.includes(entry.url));
    for (const added of input.addedExternalUrls ?? []) {
      record.externalUrls = [
        ...record.externalUrls.filter((entry) => entry.url !== added.url),
        { label: added.label, url: added.url },
      ];
    }
    if (input.externalLink)
      record.externalUrls = [
        ...record.externalUrls.filter((entry) => entry.url !== input.externalLink),
        { label: "Link", url: input.externalLink },
      ];
    const onlyTitle = Object.keys(input).every((key) => key === "summary");
    if (!onlyTitle && (record.status === "pending" || record.status === "stale")) moveTo(record, "active");
    record.updatedAt = clock();
    return record;
  };

  return {
    store,
    links,
    payloads,
    // The fake holds the truth already: a read has nothing to ask first.
    refresh: () => {},
    stateOf,
    markdown,
    readable,
    rootOf,
    updateIssue,
    comment,
    publish,
    updateSession,
    promptSession,
    startSession,

    createUser(
      session: string,
      input: {
        name: string;
        id?: string | undefined;
        displayName?: string | undefined;
        email?: string | undefined;
        admin?: boolean | undefined;
        guest?: boolean | undefined;
      },
    ) {
      const displayName = input.displayName ?? input.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "");
      if (
        store.list(store.users, session).some((user) => user.displayName.toLowerCase() === displayName.toLowerCase())
      ) {
        throw new ProtocolError("invalid_argument", `There is already a person "${displayName}" in this session`);
      }
      const id = input.id === undefined ? ids.next("linear.uuid") : ids.reserve("linear.uuid", input.id);
      return store.add(store.users, session, {
        id,
        name: input.name,
        displayName,
        email: input.email ?? `${displayName}@acme.example`,
        admin: input.admin ?? false,
        guest: input.guest ?? false,
        app: false,
        fixedId: input.id !== undefined,
        createdAt: clock(),
      } satisfies LinearUserRecord);
    },

    createTeam(
      session: string,
      input: {
        key?: string | undefined;
        name?: string | undefined;
        members: readonly string[];
        states?: ReadonlyArray<{ name: string; type: LinearStateType }> | undefined;
        labels?: readonly string[] | undefined;
      },
    ) {
      // A generated key is unique in the world, so parallel tests never share an `ENG-1`.
      const key = input.key ?? ids.next("linear.teamKey");
      if (!ID_FORMATS["linear.teamKey"].accepts.test(key))
        throw new ProtocolError(
          "invalid_argument",
          `"${key}" is not a team key: 1 to 7 capital letters or digits, starting with a letter`,
        );
      if (store.all(store.teams).some((team) => team.key === key)) {
        throw new ProtocolError(
          "invalid_argument",
          `A team with the key ${key} already exists, here or in another open session`,
        );
      }
      const states = (input.states ?? DEFAULT_STATES.map(([name, type, color]) => ({ name, type, color }))).map(
        (state, position): LinearStateRecord => ({
          id: ids.next("linear.uuid"),
          name: state.name,
          type: state.type,
          color: "color" in state && typeof state.color === "string" ? state.color : STATE_COLOR[state.type],
          position,
        }),
      );
      if (states.length === 0) throw new ProtocolError("invalid_argument", "A team needs at least one workflow state");
      return store.add(store.teams, session, {
        id: ids.next("linear.uuid"),
        key,
        name: input.name ?? key,
        members: [...input.members],
        states,
        labels: (input.labels ?? []).map((name) => ({ id: ids.next("linear.uuid"), name, color: "#bec2c8" })),
        createdAt: clock(),
      } satisfies LinearTeamRecord);
    },

    /** Create an issue as a person or the app. Sends `Issue` (`create`), and with a delegate opens a session. */
    createIssue(team: LinearTeamRecord, creator: string, input: LinearIssueInput): LinearIssueRecord {
      const session = store.teams.owner(team.id);
      if (session === undefined) throw new Error("A team belongs to a test session");
      if (input.title.trim() === "") throw new LinearError("title must not be empty");
      const state = input.state
        ? stateNamed(team, input.state)
        : (team.states.find((candidate) => candidate.type === "backlog") ??
          team.states.find((candidate) => candidate.type === "unstarted") ??
          (team.states[0] as LinearStateRecord));
      const labels = labelsNamed(team, input.labels ?? []);
      if (input.delegate !== undefined && input.delegate !== store.appUser.id)
        throw new LinearError("Only an agent can be delegated an issue");
      const number = ids.sequence(`linear.identifier:${team.key}`);
      const now = clock();
      const issue = store.add(store.issues, session, {
        id: ids.next("linear.uuid"),
        team: team.id,
        number,
        identifier: `${team.key}-${number}`,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? 0,
        state: state.id,
        labels: labels.map((label) => label.id),
        assignee: input.assignee ?? null,
        delegate: input.delegate ?? null,
        creator,
        parent: input.parent ?? null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
        canceledAt: null,
      } satisfies LinearIssueRecord);
      enterState(issue, state);
      entityEvent(session, "Issue", "create", creator, payloads.issue(issue), links.issue(issue));
      if (issue.delegate) startSession(issue, creator, undefined);
      return issue;
    },

    editComment(record: LinearCommentRecord, actor: string, body: string) {
      if (body.trim() === "") throw new LinearError("body must not be empty");
      const issue = store.issue(record.issue);
      const before = record.body;
      record.body = body;
      record.updatedAt = clock();
      record.editedAt = clock();
      return entityEvent(
        store.sessionOf(issue),
        "Comment",
        "update",
        actor,
        payloads.comment(record),
        links.comment(issue, record.id),
        { body: before },
      );
    },

    deleteComment(record: LinearCommentRecord, actor: string) {
      const issue = store.issue(record.issue);
      const session = store.sessionOf(issue);
      const data = payloads.comment(record);
      store.forget(store.comments, record.id);
      return entityEvent(session, "Comment", "remove", actor, data, links.comment(issue, record.id));
    },

    react(record: LinearCommentRecord, user: string, emoji: string) {
      if (record.reactions.some((reaction) => reaction.user === user && reaction.emoji === emoji)) return;
      record.reactions.push({ id: ids.next("linear.uuid"), emoji, user, createdAt: clock() });
    },

    /** A person presses Stop: the session is stopping until the agent ends its turn. */
    stop(record: LinearSessionRecord, user: string) {
      return promptSession(record, user, "Stop", { signal: "stop" });
    },

    /** Send a delivery again, unchanged (stamped with the time it is sent), stale, or signed with a secret that isn't the app's. */
    resend(session: string, id: string, options: { badSignature: boolean; stale: boolean }) {
      const { request } = delivery.get(session, id);
      const secret = options.badSignature ? randomToken() : context.secret("webhookSecret");
      return delivery.again(session, id, {
        sign: signedWith(secret, id, request.type),
        // Linear's receivers refuse a timestamp more than a minute away from now.
        ...(options.stale ? { atMs: clock() - 120_000 } : {}),
        forged: options.badSignature || options.stale,
      });
    },

    /** Redeliver, as Linear retries: the same delivery, stamped and signed again. */
    redeliver: (session: string, id: string) => delivery.again(session, id),
    deliveries: (session: string) => delivery.list(session).filter(({ request }) => request.driver === "linear"),
    delivery: (session: string, id: string) => delivery.get(session, id),
  };
}

export type FakeLinearWorld = ReturnType<typeof createFakeWorld>;
