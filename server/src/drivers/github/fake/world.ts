import type { DeliveryAttempt, DeliveryRecord } from "../../../core/delivery/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { GITHUB_IDS } from "../ids.ts";
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
export function createFakeWorld(context: DriverContext, store: GitHubStore, git: GitStore) {
  const kit = createKit(context, store, git);
  const repos = createRepos(kit);
  const issues = createIssues(kit, repos);
  const pulls = createPulls(kit, repos, issues);
  const checks = createChecks(kit);
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
