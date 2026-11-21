import type { DeliveryAttempt, DeliveryRecord } from "../../../core/delivery/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { randomToken } from "../../../core/secrets/index.ts";
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
  const { delivery, ids, clock } = context;

  /** Send a delivery again and note it in the App's delivery log. */
  const again = async (
    session: string,
    guid: string,
    options: { secret: string; forged: boolean },
  ): Promise<DeliveryAttempt> => {
    const { request } = delivery.get(session, guid);
    const original = store.hookDeliveries.find((entry) => entry.guid === guid);
    if (original) {
      store.hookDeliveries.push({ ...original, id: Number(ids.next("github.hookDelivery")), deliveredAt: clock() });
    }
    return delivery.again(session, guid, {
      sign: (body) => kit.headers(request.type, guid, body, options.secret),
      forged: options.forged,
    });
  };

  return {
    kit,
    repos,
    issues,
    pulls,
    checks,

    deliveries: (session: string): DeliveryRecord[] =>
      delivery.list(session).filter(({ request }) => request.driver === "github"),
    delivery: (session: string, guid: string): DeliveryRecord => delivery.get(session, guid),
    /** Redeliver, as GitHub's UI and API do: the same GUID and payload, a new attempt. */
    redeliver: (session: string, guid: string) =>
      again(session, guid, { secret: context.secret("webhookSecret"), forged: false }),
    /** Send a delivery again, unchanged or signed with a secret that isn't the App's. */
    resend: (session: string, guid: string, options: { badSignature: boolean }) =>
      again(session, guid, {
        secret: options.badSignature ? randomToken() : context.secret("webhookSecret"),
        forged: options.badSignature,
      }),
  };
}

export type FakeGitHubWorld = ReturnType<typeof createFakeWorld>;
