import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { createGitHubFake } from "./fake/index.ts";
import { removeGitHubEntry } from "./live/cleanup.ts";
import { GitHubLiveClient } from "./live/client.ts";
import { githubMaintenance } from "./live/maintenance.ts";
import { createLiveGitHubWorld } from "./live/world.ts";
import { registerGitHubRoutes } from "./routes.ts";

/** The GitHub driver: the fake REST API and App webhooks, and the control actions a test's people take. */
export const github: DriverDefinition = {
  name: "github",
  secrets: {
    webhookSecret: "github.webhookSecret",
    privateKey: "github.privateKey",
    installationToken: "github.installationToken",
  },
  // A real GitHub App installed on a test org (live-mode.md, section 4). People bring their own tokens.
  live: {
    credentials: ["CHANNELSTACK_GITHUB_APP_ID", "CHANNELSTACK_GITHUB_PRIVATE_KEY"],
    allowlist: "CHANNELSTACK_LIVE_GITHUB_ORGS",
    maintenance: githubMaintenance,
  },
  create(context): Driver {
    const fake = createGitHubFake(context);
    const appId = context.live.vault.setting("CHANNELSTACK_GITHUB_APP_ID");
    const key = context.live.vault.fromEnv("CHANNELSTACK_GITHUB_PRIVATE_KEY");
    const client = new GitHubLiveClient({
      base: context.live.apiBase,
      fetch: context.live.fetch,
      app: appId && key ? { appId, key } : undefined,
    });
    const live = context.live.active
      ? createLiveGitHubWorld({ client, live: context.live, ids: context.ids, clock: context.clock })
      : undefined;
    if (live) {
      context.live.ledger.onCleanup("github", (entry) => removeGitHubEntry(client, live.installation(), entry));
    }
    return {
      name: "github",
      fake,
      ...(live ? { live } : {}),
      routes: (router) =>
        registerGitHubRoutes(router, {
          fake: fake.world,
          live,
          events: context.events,
          apiUrl: context.apiUrl,
          secret: context.secret,
        }),
      capabilities: () => ({}),
      // A check run the App started and never finished is work in progress.
      openWork: (session) =>
        fake.store
          .list(fake.store.checkRuns, session)
          .filter((run) => run.status !== "completed")
          .map((run) => `a check run "${run.name}" on ${run.headSha.slice(0, 7)} that never completed`),
      // Live, the agent talks to GitHub with its own configuration, and live credentials never leave the server.
      env: () =>
        live
          ? {}
          : {
              GITHUB_API_URL: context.apiUrl(),
              GITHUB_APP_ID: String(fake.store.app.id),
              GITHUB_APP_SLUG: fake.store.app.slug,
              GITHUB_INSTALLATION_ID: String(fake.store.app.installationId),
              GITHUB_BOT_USER_ID: String(fake.store.app.botId),
              // A PEM in one line, with `\n` for its line breaks: an .env line is one line, and Probot,
              // Octokit's App auth and most deploy targets take the key this way.
              GITHUB_PRIVATE_KEY: context.secret("privateKey").replaceAll("\n", "\\n"),
              GITHUB_WEBHOOK_SECRET: context.secret("webhookSecret"),
            },
    };
  },
};
