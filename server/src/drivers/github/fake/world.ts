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
  const repos = createRepos(kit);
  const issues = createIssues(kit, repos);
  const pulls = createPulls(kit, repos, issues);
  const checks = createChecks(kit);
  const { ids, clock } = context;
  const { deliveries } = kit;

  /** A test acts as an App it made, never as the built-in one: the agent under test acts as that. */
  const scripted = (ref: string): GitHubAppRecord => {
    const app = store.appOf(ref);
    if (app === store.app) {
      throw new ProtocolError(
        "invalid_argument",
        `${app.name} is the built-in App, which the agent under test acts as: script another App`,
        { app: String(app.id) },
      );
    }
    return app;
  };

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
    scripted,

    /** The org's Apps, the built-in one first. */
    apps: (): GitHubAppRecord[] => store.apps.all(),

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
      const events = [...(options.events ?? defaults.events)];
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
