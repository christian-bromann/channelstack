import { type Clock, pollUntil, type Timers } from "../../../core/clock/index.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { IdGenerator } from "../../../core/ids/index.ts";
import { LivePeople } from "../../../core/people/index.ts";
import {
  actionRequires,
  checkRoles,
  fakeActorInLiveWorld,
  liveMisconfigured,
  unsupportedInLive,
} from "../../../core/reality/index.ts";
import { Registry } from "../../../core/registry/index.ts";
import type { LiveContext } from "../../../core/router/index.ts";
import { taggedNames } from "../../../core/safety/index.ts";
import { type LiveCredential, randomString } from "../../../core/secrets/index.ts";
import type { LinearWorld } from "../backend.ts";
import { LinearStore } from "../fake/store.ts";
import { LINEAR_IDS } from "../ids.ts";
import { linearLinks } from "../links.ts";
import { linearText } from "../text.ts";
import type {
  LinearActivityRecord,
  LinearActivityType,
  LinearCommentRecord,
  LinearIssueRecord,
  LinearPlanEntry,
  LinearSessionRecord,
  LinearStateType,
  LinearTeamRecord,
  LinearUserRecord,
} from "../world.ts";
import type { LinearGraphqlClient } from "./client.ts";
import { checkLinearCredential, identifyLinear } from "./identity.ts";

/** Real Linear's web app: where its links point. */
const LINEAR_WEB = "https://linear.app";
/** How long a delegation waits for Linear to open the agent session. */
const SESSION_WAIT_MS = 15_000;
const SESSION_POLL_MS = 1_000;
/** How long an issue or a session read from Linear is used again before it is read anew. */
const READ_CACHE_MS = 1_000;

const ISSUE_FIELDS = /* GraphQL */ `
  fragment IssueFields on Issue {
    id
    number
    identifier
    title
    description
    priority
    createdAt
    updatedAt
    startedAt
    completedAt
    canceledAt
    team {
      id
    }
    state {
      id
    }
    labels {
      nodes {
        id
      }
    }
    assignee {
      id
    }
    delegate {
      id
    }
    creator {
      id
    }
    parent {
      id
    }
  }
`;
const COMMENT_FIELDS = /* GraphQL */ `
  fragment CommentFields on Comment {
    id
    body
    createdAt
    updatedAt
    editedAt
    user {
      id
    }
    botActor {
      type
    }
    parent {
      id
    }
    agentSession {
      id
    }
  }
`;
const SESSION_FIELDS = /* GraphQL */ `
  fragment SessionFields on AgentSession {
    id
    status
    slugId
    summary
    plan
    createdAt
    updatedAt
    startedAt
    endedAt
    issue {
      id
    }
    appUser {
      id
    }
    creator {
      id
    }
    comment {
      id
    }
    externalLinks {
      label
      url
    }
    activities(first: 100) {
      nodes {
        id
        createdAt
        ephemeral
        signal
        signalMetadata
        user {
          id
        }
        sourceComment {
          id
        }
        content {
          ... on AgentActivityThoughtContent {
            type
            body
          }
          ... on AgentActivityActionContent {
            type
            action
            parameter
            result
          }
          ... on AgentActivityElicitationContent {
            type
            body
          }
          ... on AgentActivityResponseContent {
            type
            body
          }
          ... on AgentActivityErrorContent {
            type
            body
          }
          ... on AgentActivityPromptContent {
            type
            body
          }
        }
      }
    }
  }
`;

interface WireIssue {
  id: string;
  number: number;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  team: { id: string };
  state: { id: string };
  labels: { nodes: Array<{ id: string }> };
  assignee: { id: string } | null;
  delegate: { id: string } | null;
  creator: { id: string } | null;
  parent: { id: string } | null;
}
interface WireComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  user: { id: string } | null;
  /** Who wrote a comment without a user: Linear's workflow, for the thread it opens for a delegated session. */
  botActor?: { type: string } | null;
  parent: { id: string } | null;
  agentSession: { id: string } | null;
}
interface WireSession {
  id: string;
  status: LinearSessionRecord["status"];
  slugId: string;
  summary: string | null;
  plan: { entries?: LinearPlanEntry[] } | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  issue: { id: string } | null;
  appUser: { id: string };
  creator: { id: string } | null;
  comment: { id: string } | null;
  externalLinks: Array<{ label: string; url: string }>;
  activities: {
    nodes: Array<{
      id: string;
      createdAt: string;
      ephemeral: boolean;
      signal: LinearActivityRecord["signal"];
      signalMetadata: Record<string, unknown> | null;
      user: { id: string };
      sourceComment: { id: string } | null;
      content: { type: LinearActivityType; body?: string; action?: string; parameter?: string; result?: string | null };
    }>;
  };
}

const time = (iso: string | null): number | null => (iso === null ? null : Date.parse(iso));

/** A Linear team key: a letter, then four letters or digits, unlikely to be taken in a real workspace. */
const teamKey = () =>
  `${randomString(1, "ABCDEFGHIJKLMNOPQRSTUVWXYZ")}${randomString(4, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}`;

export interface LiveLinearWorld extends LinearWorld {
  ready(): Promise<void>;
  release(session: string): void;
  /** The credential of whoever the ledger names (`app`, `user:ANA`), while their session is open. */
  credential(owner: string, session: string): LiveCredential | undefined;
}

/**
 * The live Linear world (live-mode.md, A1 and A2): people act with their personal API keys, the
 * app's OAuth token reads agent sessions, and every team a session makes is in the ledger. What it
 * reads and makes is kept in a store of its own with the fake's record shapes, so the routes read
 * from it as from the fake's.
 */
export function createLiveLinearWorld(deps: {
  client: LinearGraphqlClient;
  live: LiveContext;
  ids: IdGenerator;
  clock: Clock;
  timers: Timers;
  /** The app's name as tests write it (`@my-agent`). */
  appName: string;
}): LiveLinearWorld {
  const { client, live, ids, clock, timers } = deps;
  const registry = new Registry();
  const store = new LinearStore(registry);
  const links = linearLinks(
    () => LINEAR_WEB,
    () => store.org,
  );
  const appToken = live.vault.fromEnv("CHANNELSTACK_LINEAR_APP_TOKEN");
  /** The real people the open sessions hold: one record each, whichever sessions have them. */
  const people = new LivePeople();
  const aliases = new Map<string, string>();
  let checked: Promise<void> | undefined;
  const readAt = new Map<string, number>();
  const teamName = taggedNames(live.tag);

  const text = linearText(store, links, (session, name) => {
    const wanted = name.toLowerCase();
    if (wanted === deps.appName.toLowerCase() || wanted === store.appUser.displayName.toLowerCase()) {
      return store.appUser.id;
    }
    // The session's own people: its fake ones, and the real ones it holds, by the session's name too.
    const held = people.of(session);
    const users = [...store.list(store.users, session), ...held.flatMap(({ id }) => store.users.find(id) ?? [])];
    return users.find(
      (user) =>
        user.displayName.toLowerCase() === wanted ||
        user.name.toLowerCase() === wanted ||
        (held.find((person) => person.id === user.id)?.alias ?? aliases.get(user.id))?.toLowerCase() === wanted,
    )?.id;
  });

  const app = (): LiveCredential => {
    if (!appToken)
      throw liveMisconfigured("CHANNELSTACK_LINEAR_APP_TOKEN isn't set", "set the agent app's OAuth token");
    return appToken;
  };
  /** The person acting, who must be real: a fake person can't act in a live workspace (core's rule). */
  const actor = (session: string, userId: string): LiveCredential =>
    people.actingAs(session, userId, () =>
      fakeActorInLiveWorld(aliases.get(userId) ?? store.user(userId)?.name ?? userId, "linear"),
    );

  const toIssue = (issue: WireIssue): LinearIssueRecord => ({
    id: issue.id,
    team: issue.team.id,
    number: issue.number,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state.id,
    labels: issue.labels.nodes.map((label) => label.id),
    assignee: issue.assignee?.id ?? null,
    delegate: issue.delegate?.id ?? null,
    creator: issue.creator?.id ?? store.appUser.id,
    parent: issue.parent?.id ?? null,
    createdAt: Date.parse(issue.createdAt),
    updatedAt: Date.parse(issue.updatedAt),
    startedAt: time(issue.startedAt),
    completedAt: time(issue.completedAt),
    canceledAt: time(issue.canceledAt),
  });
  const toComment = (comment: WireComment, issue: string): LinearCommentRecord => ({
    id: comment.id,
    issue,
    user: comment.user?.id ?? store.appUser.id,
    body: comment.body,
    parent: comment.parent?.id ?? null,
    reactions: [],
    createdAt: Date.parse(comment.createdAt),
    updatedAt: Date.parse(comment.updatedAt),
    editedAt: time(comment.editedAt),
    session: comment.agentSession?.id,
    // Only the fake delivers: live, Linear delivers to the agent itself.
    delivery: undefined,
    prompted: undefined,
    ...(comment.user === null && comment.botActor?.type === "workflow" ? { byLinear: true } : {}),
  });

  /** Someone the session's view names: a person of the session, the app, or someone else in the workspace. */
  const ensureUsers = async (session: string, userIds: Iterable<string>) => {
    for (const id of new Set(userIds)) {
      if (store.user(id)) continue;
      const answer = await client.call<{
        user: { id: string; name: string; displayName: string; admin: boolean; guest: boolean };
      }>(
        app(),
        /* GraphQL */ `
          query User($id: String!) {
            user(id: $id) {
              id
              name
              displayName
              admin
              guest
            }
          }
        `,
        { id },
      );
      store.add(store.users, session, {
        ...answer.user,
        email: "",
        app: false,
        fixedId: false,
        createdAt: clock(),
      } satisfies LinearUserRecord);
    }
  };

  const upsertSessions = async (session: string, sessions: WireSession[]) => {
    for (const wire of sessions) {
      const issue = wire.issue?.id;
      if (issue === undefined || !store.issues.find(issue)) continue;
      // The thread a person replies in: the mention that opened it, or the first comment the app wrote for it.
      const opened =
        wire.comment?.id ?? wire.activities.nodes.find((activity) => activity.sourceComment)?.sourceComment?.id;
      const root = opened === undefined ? undefined : store.comments.find(opened);
      const record: LinearSessionRecord = {
        id: wire.id,
        issue,
        appUser: wire.appUser.id,
        creator: wire.creator?.id ?? store.appUser.id,
        comment: wire.comment?.id ?? null,
        thread: root ? text.rootOf(root).id : (opened ?? null),
        status: wire.status,
        plan: wire.plan?.entries ? { entries: wire.plan.entries, updatedAt: Date.parse(wire.updatedAt) } : null,
        externalUrls: wire.externalLinks.map((link) => ({ label: link.label, url: link.url })),
        summary: wire.summary,
        slugId: wire.slugId,
        createdAt: Date.parse(wire.createdAt),
        updatedAt: Date.parse(wire.updatedAt),
        startedAt: time(wire.startedAt),
        endedAt: time(wire.endedAt),
        delivery: undefined,
      };
      store.add(store.sessions, session, record);
      // Linear answers newest first; the store keeps what it holds in the order it first saw it, and
      // every reader (the route, the transcript) reads oldest first.
      const oldestFirst = [...wire.activities.nodes].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      for (const activity of oldestFirst) {
        store.add(store.activities, session, {
          id: activity.id,
          session: wire.id,
          user: activity.user.id,
          content: {
            type: activity.content.type,
            ...(activity.content.body === undefined ? {} : { body: activity.content.body }),
            ...(activity.content.action === undefined ? {} : { action: activity.content.action }),
            ...(activity.content.parameter === undefined ? {} : { parameter: activity.content.parameter }),
            ...(activity.content.result === undefined ? {} : { result: activity.content.result }),
          },
          ephemeral: activity.ephemeral,
          signal: activity.signal,
          signalMetadata: activity.signalMetadata,
          sourceComment: activity.sourceComment?.id ?? null,
          createdAt: Date.parse(activity.createdAt),
        } satisfies LinearActivityRecord);
      }
      await ensureUsers(session, [record.creator, ...wire.activities.nodes.map((activity) => activity.user.id)]);
    }
  };

  const refreshSession = async (session: string, id: string) => {
    const answer = await client.call<{ agentSession: WireSession }>(
      app(),
      /* GraphQL */ `
        query RefreshSession($id: String!) {
          agentSession(id: $id) {
            ...SessionFields
          }
        }
        ${SESSION_FIELDS}
      `,
      { id },
    );
    await upsertSessions(session, [answer.agentSession]);
  };
  const refreshIssue = async (session: string, issueId: string) => {
    const answer = await client.call<{ issue: WireIssue & { comments: { nodes: WireComment[] } } }>(
      app(),
      /* GraphQL */ `
        query RefreshIssue($id: String!) {
          issue(id: $id) {
            ...IssueFields
            comments(first: 250) {
              nodes {
                ...CommentFields
              }
            }
          }
        }
        ${ISSUE_FIELDS}
        ${COMMENT_FIELDS}
      `,
      { id: issueId },
    );
    const current = store.issues.find(issueId);
    if (current) Object.assign(current, toIssue(answer.issue));
    // Oldest first, as the fake lists them.
    const comments = [...answer.issue.comments.nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await ensureUsers(
      session,
      comments.flatMap((comment) => (comment.user ? [comment.user.id] : [])),
    );
    for (const comment of comments) store.add(store.comments, session, toComment(comment, issueId));
    // The app's sessions: the query takes no filter, so the issue's are picked out here.
    // Only ids and issues in the list: with every activity, Linear refuses it as too complex. Then each
    // of this issue's sessions in full, oldest first.
    const listed = await client.call<{ agentSessions: { nodes: Array<{ id: string; issue: { id: string } | null }> } }>(
      app(),
      /* GraphQL */ `
        query RefreshSessions {
          agentSessions(first: 50) {
            nodes {
              id
              issue {
                id
              }
            }
          }
        }
      `,
    );
    for (const node of listed.agentSessions.nodes.filter((candidate) => candidate.issue?.id === issueId).reverse()) {
      await refreshSession(session, node.id);
    }
  };

  const world: LiveLinearWorld = {
    store,
    links,
    markdown: text.markdown,
    readable: text.readable,
    rootOf: text.rootOf,
    stateOf: text.stateOf,

    async ready() {
      checked ??= (async () => {
        const who = await identifyLinear(client, app());
        checkLinearCredential(who, { role: "app", who: "CHANNELSTACK_LINEAR_APP_TOKEN", allowlist: live.allowlist });
        const now = clock();
        store.seed(
          { id: who.org.id, name: who.org.name, urlKey: who.org.urlKey },
          { userId: who.user, name: deps.appName, events: [], webhookId: "", createdAt: now },
          {
            id: who.user,
            name: deps.appName,
            displayName: who.displayName,
            email: "",
            admin: false,
            guest: false,
            app: true,
            fixedId: false,
            createdAt: now,
          },
        );
      })().catch((error: unknown) => {
        // A definitive answer is kept; a network error or a rate limit isn't: the next action asks again.
        if (!(error instanceof ProtocolError) || error.code === "RATELIMITED" || error.code === "unexpected") {
          checked = undefined;
        }
        throw error;
      });
      return checked;
    },

    release(session) {
      // A person another open session holds stays theirs.
      const gone = people.leave(session);
      registry.release(session);
      for (const id of gone) store.users.remove(id);
    },

    credential(owner, session) {
      if (owner === "app") return appToken;
      return people.byOwner(session, owner);
    },

    async createUser(session, input) {
      if (input.id !== undefined) {
        throw unsupportedInLive(
          "LinearFixture.createUser({ id })",
          "real ids are assigned by Linear; a live person has the id of their account",
        );
      }
      if (input.token === undefined) {
        if (live.strict) {
          throw liveMisconfigured(
            `CHANNELSTACK_REALITY is live and ${input.name} has no token`,
            "set CHANNELSTACK_LINEAR_USER_<NAME>_TOKEN for them, or run without CHANNELSTACK_REALITY=live",
          );
        }
        // A fake person can exist next to a live workspace, but can't act in it.
        const id = ids.next(LINEAR_IDS.uuid);
        aliases.set(id, input.name);
        return store.add(store.users, session, {
          id,
          name: input.name,
          displayName: input.displayName ?? input.name.toLowerCase().replace(/[^a-z0-9._-]+/g, ""),
          email: "",
          admin: false,
          guest: false,
          app: false,
          fixedId: false,
          createdAt: clock(),
        } satisfies LinearUserRecord);
      }
      const key = live.vault.person(input.name, input.token);
      const who = await identifyLinear(client, key);
      checkLinearCredential(who, {
        role: "person",
        who: `${input.name}'s key`,
        allowlist: live.allowlist,
        appOrg: store.org.id,
      });
      checkRoles(input.name, [
        { option: "admin", wanted: input.admin, has: who.admin, role: "a workspace admin" },
        { option: "guest", wanted: input.guest, has: who.guest, role: "a guest" },
      ]);
      people.join(session, who.user, input.name, key);
      // One record, no session's: parallel tests have the same person.
      const record = {
        id: who.user,
        name: who.name,
        displayName: who.displayName,
        // A real person's email never leaves the server.
        email: "",
        admin: who.admin,
        guest: who.guest,
        app: false,
        fixedId: false,
        createdAt: clock(),
      } satisfies LinearUserRecord;
      const known = store.users.find(who.user);
      return known ? Object.assign(known, record) : store.users.add(who.user, record);
    },

    async createTeam(session, input) {
      const real = input.members.filter((id) => people.holds(session, id));
      for (const member of input.members) actor(session, member);
      const creatorId = real[0] ?? people.of(session)[0]?.id;
      if (creatorId === undefined) {
        throw actionRequires(
          "LinearFixture.createTeam",
          "a real person",
          "a live team is created by a person with a key; the app can't create teams",
        );
      }
      const creator = actor(session, creatorId);
      // A real workspace's keys and names are unique: the run's tag in the name, a key of its own.
      const name = teamName(input.name);
      const created = await client.call<{
        teamCreate: {
          team: {
            id: string;
            key: string;
            name: string;
            states: {
              nodes: Array<{ id: string; name: string; type: LinearStateType; color: string; position: number }>;
            };
          };
        };
      }>(
        creator,
        /* GraphQL */ `
          mutation TeamCreate($input: TeamCreateInput!) {
            teamCreate(input: $input) {
              team {
                id
                key
                name
                states {
                  nodes {
                    id
                    name
                    type
                    color
                    position
                  }
                }
              }
            }
          }
        `,
        { input: { name, key: teamKey() } },
      );
      const team = created.teamCreate.team;
      live.ledger.record({
        channel: "linear",
        kind: "team",
        ref: { team: team.id, name: team.name },
        workspace: store.org.id,
        by: creator.owner,
        session,
      });
      for (const member of real.filter((id) => id !== creatorId)) {
        await client.call(
          creator,
          /* GraphQL */ `
            mutation TeamMembershipCreate($input: TeamMembershipCreateInput!) {
              teamMembershipCreate(input: $input) {
                success
              }
            }
          `,
          { input: { teamId: team.id, userId: member } },
        );
      }
      const states = [...team.states.nodes].sort((a, b) => a.position - b.position);
      for (const wanted of input.states ?? []) {
        if (states.some((state) => state.name.toLowerCase() === wanted.name.toLowerCase())) continue;
        const made = await client.call<{
          workflowStateCreate: {
            workflowState: { id: string; name: string; type: LinearStateType; color: string; position: number };
          };
        }>(
          creator,
          /* GraphQL */ `
            mutation WorkflowStateCreate($input: WorkflowStateCreateInput!) {
              workflowStateCreate(input: $input) {
                workflowState {
                  id
                  name
                  type
                  color
                  position
                }
              }
            }
          `,
          { input: { teamId: team.id, name: wanted.name, type: wanted.type, color: "#bec2c8" } },
        );
        states.push(made.workflowStateCreate.workflowState);
      }
      const labels = [];
      for (const label of input.labels ?? []) {
        const made = await client.call<{
          issueLabelCreate: { issueLabel: { id: string; name: string; color: string } };
        }>(
          creator,
          /* GraphQL */ `
            mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
              issueLabelCreate(input: $input) {
                issueLabel {
                  id
                  name
                  color
                }
              }
            }
          `,
          { input: { teamId: team.id, name: label } },
        );
        labels.push(made.issueLabelCreate.issueLabel);
      }
      return store.add(store.teams, session, {
        id: team.id,
        key: team.key,
        name: team.name,
        members: [creatorId, ...input.members.filter((id) => id !== creatorId)],
        states,
        labels,
        createdAt: clock(),
      } satisfies LinearTeamRecord);
    },

    async createIssue(team, creator, input) {
      const session = store.teams.owner(team.id);
      if (session === undefined) throw new Error("A team belongs to a test session");
      const key = actor(session, creator);
      const state =
        input.state === undefined
          ? undefined
          : team.states.find((candidate) => candidate.name.toLowerCase() === input.state?.toLowerCase());
      if (input.state !== undefined && !state)
        throw new ProtocolError("not_found", `${team.key} has no state "${input.state}"`);
      const labelIds = (input.labels ?? []).map((name) => {
        const label = team.labels.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
        if (!label) throw new ProtocolError("not_found", `${team.key} has no label "${name}"`);
        return label.id;
      });
      const answer = await client.call<{ issueCreate: { issue: WireIssue } }>(
        key,
        /* GraphQL */ `
          mutation IssueCreate($input: IssueCreateInput!) {
            issueCreate(input: $input) {
              issue {
                ...IssueFields
              }
            }
          }
          ${ISSUE_FIELDS}
        `,
        {
          input: {
            teamId: team.id,
            title: input.title,
            description: input.description,
            priority: input.priority,
            stateId: state?.id,
            labelIds: labelIds.length > 0 ? labelIds : undefined,
            assigneeId: input.assignee,
            delegateId: input.delegate,
            parentId: input.parent,
          },
        },
      );
      const issue = store.add(store.issues, session, toIssue(answer.issueCreate.issue));
      if (input.delegate !== undefined) await world.refresh(session, { issue: issue.id });
      return issue;
    },

    async updateIssue(issue, actorId, changes) {
      const session = store.sessionOf(issue);
      const key = actor(session, actorId);
      const answer = await client.call<{ issueUpdate: { issue: WireIssue } }>(
        key,
        /* GraphQL */ `
          mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) {
              issue {
                ...IssueFields
              }
            }
          }
          ${ISSUE_FIELDS}
        `,
        {
          id: issue.id,
          input: {
            title: changes.title,
            description: changes.description,
            priority: changes.priority,
            stateId: changes.stateId,
            labelIds: changes.labelIds,
            assigneeId: changes.assigneeId,
            delegateId: changes.delegateId,
          },
        },
      );
      Object.assign(issue, toIssue(answer.issueUpdate.issue));
      // Delegating opens an agent session on Linear's side, a moment later: wait for it.
      if (changes.delegateId !== undefined && changes.delegateId !== null) {
        const before = store.sessionsOn(issue).length;
        await pollUntil(
          { clock, timers },
          { withinMs: SESSION_WAIT_MS, everyMs: SESSION_POLL_MS },
          async () => {
            // Linear's answer now, not the one read a moment ago.
            readAt.delete(issue.id);
            await world.refresh(session, { issue: issue.id });
            return store.sessionsOn(issue).length > before ? true : undefined;
          },
          () =>
            new ProtocolError(
              { platform: "no_agent_session", status: 409 },
              `Linear opened no agent session for ${issue.identifier} within ${SESSION_WAIT_MS / 1000}s: Linear opens one only for an app installed as an agent whose webhook, with agent session events, reaches a running agent`,
            ),
        );
      }
      // Live, Linear delivers to the agent itself: there is no delivery here.
      return undefined;
    },

    async comment(issue, user, body, parent) {
      const session = store.sessionOf(issue);
      const key = actor(session, user);
      const answer = await client.call<{ commentCreate: { comment: WireComment } }>(
        key,
        /* GraphQL */ `
          mutation CommentCreate($input: CommentCreateInput!) {
            commentCreate(input: $input) {
              comment {
                ...CommentFields
              }
            }
          }
          ${COMMENT_FIELDS}
        `,
        { input: { issueId: issue.id, body, parentId: parent?.id } },
      );
      return store.add(store.comments, session, toComment(answer.commentCreate.comment, issue.id));
    },

    async editComment(record, actorId, body) {
      const answer = await client.call<{ commentUpdate: { comment: WireComment } }>(
        actor(store.sessionOf(store.issue(record.issue)), actorId),
        /* GraphQL */ `
          mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
            commentUpdate(id: $id, input: $input) {
              comment {
                ...CommentFields
              }
            }
          }
          ${COMMENT_FIELDS}
        `,
        { id: record.id, input: { body } },
      );
      Object.assign(record, toComment(answer.commentUpdate.comment, record.issue));
      return undefined;
    },

    async deleteComment(record, actorId) {
      await client.call(
        actor(store.sessionOf(store.issue(record.issue)), actorId),
        /* GraphQL */ `
          mutation CommentDelete($id: String!) {
            commentDelete(id: $id) {
              success
            }
          }
        `,
        { id: record.id },
      );
      store.forget(store.comments, record.id);
      return undefined;
    },

    async react(record, user, emoji) {
      await client.call(
        actor(store.sessionOf(store.issue(record.issue)), user),
        /* GraphQL */ `
          mutation ReactionCreate($input: ReactionCreateInput!) {
            reactionCreate(input: $input) {
              success
            }
          }
        `,
        { input: { commentId: record.id, emoji } },
      );
      record.reactions.push({ id: ids.next(LINEAR_IDS.uuid), emoji, user, createdAt: clock() });
    },

    async promptSession(record, user) {
      const session = store.sessionOf(store.issue(record.issue));
      actor(session, user);
      // A person's turn is a reply in the session's thread; without one there is nothing to reply in.
      await world.refresh(session, { agentSession: record.id });
      throw unsupportedInLive(
        "LinearUser.prompt",
        "this session has no comment thread yet, and Linear takes a person's turn only as a reply in one",
      );
    },

    async refresh(session, about) {
      // A matcher reads every 50 ms: what was read a moment ago is used again, not asked for again.
      const key = "issue" in about ? about.issue : about.agentSession;
      const last = readAt.get(key);
      if (last !== undefined && clock() - last < READ_CACHE_MS) return;
      if ("issue" in about) await refreshIssue(session, about.issue);
      else await refreshSession(session, about.agentSession);
      readAt.set(key, clock());
    },
  };
  return world;
}
