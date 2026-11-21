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
        GITHUB_PRIVATE_KEY: context.secret("privateKey"),
        GITHUB_WEBHOOK_SECRET: context.secret("webhookSecret"),
      }),
    };
  },
};
