import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { createGitHubFake } from "./fake/index.ts";
import { registerGitHubRoutes } from "./routes.ts";

/** The GitHub driver: the fake REST API and App webhooks, and the control actions a test's people take. */
export const github: DriverDefinition = {
  name: "github",
  secrets: {
    webhookSecret: "github.webhookSecret",
    privateKey: "github.privateKey",
    installationToken: "github.installationToken",
  },
  // A real GitHub App on a test org (live-mode.md, section 4). Its live backend isn't built yet:
  // with these set, the driver refuses with unsupported_in_live instead of running fake.
  live: {
    credentials: ["CHANNELSTACK_GITHUB_APP_ID", "CHANNELSTACK_GITHUB_PRIVATE_KEY"],
    allowlist: "CHANNELSTACK_LIVE_GITHUB_ORGS",
  },
  create(context): Driver {
    const fake = createGitHubFake(context);
    return {
      name: "github",
      fake,
      routes: (router) =>
        registerGitHubRoutes(router, {
          world: fake.world,
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
      env: () => ({
        GITHUB_API_URL: context.apiUrl(),
        GITHUB_APP_ID: String(fake.store.app.id),
        GITHUB_APP_SLUG: fake.store.app.slug,
        GITHUB_INSTALLATION_ID: String(fake.store.app.installationId),
        GITHUB_BOT_USER_ID: String(fake.store.app.botId),
        // A PEM in one line, with `\n` for its line breaks: an .env line is one line, and Probot,
        // Octokit's App auth and most deploy targets take the key this way.
        GITHUB_PRIVATE_KEY: context.secret("privateKey").replaceAll("\n", "\\n"),
        GITHUB_WEBHOOK_SECRET: context.secret("webhookSecret"),
      }),
    };
  },
};
