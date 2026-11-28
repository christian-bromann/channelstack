import type { DeliveryAttempt, DeliveryRecord } from "../../../core/delivery/index.ts";
import { ProtocolError } from "../../../core/errors/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { GITHUB_IDS } from "../ids.ts";
import type { GitHubAppRecord } from "../world.ts";
import { createChecks } from "./checks.ts";
import type { GitStore } from "./git.ts";
import { createIssues } from "./issues.ts";
import { createKit } from "./kit.ts";
import { createPulls } from "./pulls.ts";
import { createRepos } from "./repos.ts";
import type { GitHubStore } from "./store.ts";

/**
 * The permissions that let an App subscribe to each webhook event the fake sends, any one of them
 * read or write, as GitHub's App settings offer them. `installation_repositories` needs none, and
 * isn't subscribed to.
 */
const EVENT_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  issues: ["issues"],
  issue_comment: ["issues", "pull_requests"],
  pull_request: ["pull_requests"],
  pull_request_review: ["pull_requests"],
  pull_request_review_comment: ["pull_requests"],
  pull_request_review_thread: ["pull_requests"],
  push: ["contents"],
  check_run: ["checks"],
  check_suite: ["checks"],
};

/** Do these permissions let an App subscribe to this event? */
const covers = (permissions: Readonly<Record<string, string>>, event: string) =>
  (EVENT_PERMISSIONS[event] ?? []).some((permission) => permissions[permission] !== undefined);

/** The events a test asked an App to subscribe to, each one its permissions cover, or `invalid_argument`. */
function checkedEvents(events: readonly string[], permissions: Readonly<Record<string, string>>): string[] {
  for (const event of events) {
    const needs = EVENT_PERMISSIONS[event];
    if (!needs) {
      throw new ProtocolError(
        "invalid_argument",
        `"${event}" isn't a webhook event the GitHub fake sends. It sends: ${Object.keys(EVENT_PERMISSIONS).join(", ")}`,
        { event },
      );
    }
    if (!covers(permissions, event)) {
      throw new ProtocolError(
        "invalid_argument",
        `An App subscribes to ${event} only with the ${needs.join(" or ")} permission, as GitHub's App settings allow`,
        { event },
      );
    }
  }
  return [...events];
}

/**
 * The fake GitHub world: every change to the state happens in one of its parts, once, for people
 * and for the App alike. The caller (the REST API for the App, the control API for people)
 * brings the permission check.
 */
export function createFakeWorld(
  context: DriverContext,
  store: GitHubStore,
  git: GitStore,
  defaults: Pick<GitHubAppRecord, "permissions" | "events">,
) {
  const kit = createKit(context, store, git);
  const checks = createChecks(kit);
  const repos = createRepos(kit, checks);
  const issues = createIssues(kit, repos);
  const pulls = createPulls(kit, repos, issues);
  const { ids, clock } = context;
  const { deliveries } = kit;

  /** Note a delivery sent again in the App's delivery log, as GitHub lists every attempt there. */
  const logged = (guid: string, attempt: Promise<DeliveryAttempt>): Promise<DeliveryAttempt> => {
    const original = store.hookDeliveries.find((entry) => entry.guid === guid);
    if (original) {
      store.hookDeliveries.push({ ...original, id: Number(ids.next(GITHUB_IDS.hookDelivery)), deliveredAt: clock() });
    }
    return attempt;
  };

  return {
    kit,
    repos,
    issues,
    pulls,
    checks,

    /** The Apps a session used (decision 0027): the built-in one first, then each it got from `createApp`. */
    apps: (session: string): GitHubAppRecord[] => store.apps.of(session),

    /**
     * Make a GitHub App by name, installed on the org with selected repositories (none yet), or
     * return the one made with the same settings (decision 0027). Its ids come from the seed and its
     * name; its key, webhook secret and installation token from the install's secrets.
     */
    createApp(
      session: string | undefined,
      options: {
        name: string;
        permissions?: Readonly<Record<string, "read" | "write">> | undefined;
        events?: readonly string[] | undefined;
      },
    ): GitHubAppRecord {
      const permissions = { ...(options.permissions ?? defaults.permissions) };
      // GitHub lets an App subscribe only to the events its permissions cover.
      const events = options.events
        ? checkedEvents(options.events, permissions)
        : defaults.events.filter((event) => covers(permissions, event));
      const by =
        session === undefined
          ? undefined
          : { session, people: store.list(store.users, session).map((user) => user.login) };
      const app = store.apps.make(
        options.name,
        { permissions, events },
        () => {
          const appIds = context.apps.ids(options.name);
          return {
            id: Number(appIds.next(GITHUB_IDS.app)),
            slug: options.name,
            name: options.name,
            clientId: appIds.next(GITHUB_IDS.clientId),
            botId: Number(appIds.next(GITHUB_IDS.user)),
            installationId: Number(appIds.next(GITHUB_IDS.installation)),
            events,
            permissions,
            createdAt: clock(),
          };
        },
        by,
      );
      if (session !== undefined) {
        context.events.append(session, "github", "action", { action: "createApp", app: String(app.id) });
      }
      return app;
    },

    deliveries: (session: string): DeliveryRecord[] => deliveries.deliveries(session),
    delivery: (session: string, guid: string): DeliveryRecord => deliveries.delivery(session, guid),
    /** Redeliver, as GitHub's UI and API do: the same GUID and payload, a new attempt. */
    redeliver: (session: string, guid: string) => {
      // Looked up first, so a delivery of another session isn't logged before it is refused.
      deliveries.delivery(session, guid);
      return logged(guid, deliveries.redeliver(session, guid));
    },
    /** Send a delivery again, unchanged or signed with a secret that isn't the App's. */
    resend: (session: string, guid: string, options: { badSignature: boolean }) => {
      deliveries.delivery(session, guid);
      return logged(guid, deliveries.resend(session, guid, options));
    },
  };
}

export type FakeGitHubWorld = ReturnType<typeof createFakeWorld>;
