import type { DriverContext, FakeBackend } from "../../../core/router/index.ts";
import { createGitHubApi } from "./api/index.ts";
import { GitStore } from "./git.ts";
import { GitHubStore } from "./store.ts";
import { createFakeWorld, type FakeGitHubWorld } from "./world.ts";

/**
 * The agent's App, until `channelstack.config.ts` describes it: the permissions and webhook
 * events an agent that works on issues, pull requests and checks usually has.
 */
const DEFAULT_APP = {
  slug: "my-agent",
  permissions: { issues: "write", pull_requests: "write", contents: "write", checks: "write", statuses: "write" },
  events: [
    "issues",
    "issue_comment",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "pull_request_review_thread",
    "push",
    "check_run",
    "installation_repositories",
  ],
} as const;

export interface GitHubFake extends FakeBackend {
  readonly world: FakeGitHubWorld;
  readonly store: GitHubStore;
}

/** The GitHub fake: the REST API over an in-memory org, wired to core's ids, event log and delivery queue. */
export function createGitHubFake(context: DriverContext): GitHubFake {
  const store = new GitHubStore(context.registry);
  const git = new GitStore();
  const world = createFakeWorld(context, store, git);
  const fake = {
    api: createGitHubApi(context, world),
    world,
    store,
    seed() {
      git.clear();
      store.seed(
        { id: Number(context.ids.next("github.user")), login: "acme" },
        {
          id: Number(context.ids.next("github.app")),
          slug: DEFAULT_APP.slug,
          name: DEFAULT_APP.slug,
          clientId: context.ids.next("github.clientId"),
          botId: Number(context.ids.next("github.user")),
          installationId: Number(context.ids.next("github.installation")),
          events: DEFAULT_APP.events,
          permissions: DEFAULT_APP.permissions,
          createdAt: context.clock(),
        },
      );
    },
    release(session: string) {
      const released = store.release(session);
      for (const repo of released.repos) git.remove(world.kit.dir(repo));
      // Ids a test fixed are free again once its session is gone (decision 0006).
      for (const user of released.users) if (user.fixedId) context.ids.release("github.user", String(user.id));
    },
  } satisfies GitHubFake;
  fake.seed();
  return fake;
}
