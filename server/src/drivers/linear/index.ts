import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { createLinearFake } from "./fake/index.ts";
import { registerLinearRoutes } from "./routes.ts";

/** The Linear driver: the fake GraphQL API and agent webhooks, and the control actions a test's people take. */
export const linear: DriverDefinition = {
  name: "linear",
  secrets: {
    oauthToken: "linear.oauthToken",
    webhookSecret: "linear.webhookSecret",
    clientId: "linear.clientId",
    clientSecret: "linear.clientSecret",
  },
  // The agent app's OAuth token in a test workspace (live-mode.md, section 4). Its live backend
  // isn't built yet: with it set, the driver refuses with unsupported_in_live instead of running fake.
  live: { credentials: ["CHANNELSTACK_LINEAR_APP_TOKEN"], allowlist: "CHANNELSTACK_LIVE_LINEAR_WORKSPACES" },
  create(context): Driver {
    const fake = createLinearFake(context);
    return {
      name: "linear",
      fake,
      routes: (router) =>
        registerLinearRoutes(router, {
          world: fake.world,
          events: context.events,
          apiUrl: context.apiUrl,
          secret: context.secret,
        }),
      capabilities: () => ({}),
      // A session the agent hasn't finished is work in progress: it waits for the agent, or the agent is working.
      openWork: (session) =>
        fake.store
          .list(fake.store.sessions, session)
          .filter((record) => record.status === "pending" || record.status === "active" || record.status === "stopping")
          .map(
            (record) =>
              `an agent session on ${fake.store.issue(record.issue).identifier} that is still ${record.status}`,
          ),
      env: () => ({
        LINEAR_API_URL: `${context.apiUrl()}/graphql`,
        LINEAR_ACCESS_TOKEN: context.secret("oauthToken"),
        LINEAR_WEBHOOK_SECRET: context.secret("webhookSecret"),
        LINEAR_CLIENT_ID: context.secret("clientId"),
        LINEAR_CLIENT_SECRET: context.secret("clientSecret"),
      }),
    };
  },
};
