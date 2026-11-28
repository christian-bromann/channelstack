import { BUILT_IN_APP } from "../../core/apps/index.ts";
import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { linearDev } from "./dev.ts";
import { createLinearFake } from "./fake/index.ts";
import { LINEAR_IDS } from "./ids.ts";
import { removeLinearEntry } from "./live/cleanup.ts";
import { LinearGraphqlClient } from "./live/client.ts";
import { linearMaintenance } from "./live/maintenance.ts";
import { createLiveLinearWorld } from "./live/world.ts";
import { registerLinearRoutes } from "./routes.ts";
import { LINEAR_SECRETS } from "./secrets.ts";

/** The Linear driver: the fake GraphQL API and agent webhooks, and the control actions a test's people take. */
export const linear: DriverDefinition = {
  name: "linear",
  title: "Linear",
  dev: linearDev,
  ids: LINEAR_IDS,
  tokenPatterns: [/lin_(?:api|oauth|wh)_[A-Za-z0-9]{16,}/g],
  liveTokens: [LINEAR_SECRETS.apiKey],
  hosts: ["api.linear.app"],
  secrets: {
    oauthToken: LINEAR_SECRETS.oauthToken,
    webhookSecret: LINEAR_SECRETS.webhookSecret,
    clientId: LINEAR_SECRETS.clientId,
    clientSecret: LINEAR_SECRETS.clientSecret,
  },
  // The agent app's OAuth token in a test workspace (live-mode.md, section 4). People bring their own keys.
  live: {
    credentials: ["CHANNELSTACK_LINEAR_APP_TOKEN"],
    allowlist: "CHANNELSTACK_LIVE_LINEAR_WORKSPACES",
    maintenance: linearMaintenance,
  },
  create(context): Driver {
    const fake = createLinearFake(context);
    const client = new LinearGraphqlClient({
      url: context.live.apiBase,
      fetch: context.live.fetch,
      timers: context.timers,
    });
    const live = context.live.active
      ? createLiveLinearWorld({
          client,
          live: context.live,
          ids: context.ids,
          clock: context.clock,
          timers: context.timers,
          appName: fake.store.appUser.name,
        })
      : undefined;
    if (live) {
      context.live.ledger.onCleanup("linear", (entry) =>
        removeLinearEntry(client, (owner) => live.credential(owner, entry.session), entry),
      );
    }
    return {
      name: "linear",
      fake,
      ...(live ? { live } : {}),
      routes: (router) =>
        registerLinearRoutes(router, {
          fake: fake.world,
          live,
          events: context.events,
          apiUrl: context.apiUrl,
          secret: (name, app) => context.apps.secret(app ?? BUILT_IN_APP, name),
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
      // Live, `channelstack env` prints nothing for Linear (app.ts): the agent talks to it with its own configuration.
      env: (app) => {
        // Another app's lines have the built-in app's keys, so its agent starts from an .env of the same
        // shape; asking for them makes the app, so its agent can start before any test has.
        const { apps } = fake.store;
        const name = apps.keyOf(apps.forEnv(app, (wanted) => fake.world.createApp(undefined, { name: wanted })));
        return {
          LINEAR_API_URL: `${context.apiUrl()}/graphql`,
          LINEAR_ACCESS_TOKEN: context.apps.secret(name, "oauthToken"),
          LINEAR_WEBHOOK_SECRET: context.apps.secret(name, "webhookSecret"),
          LINEAR_CLIENT_ID: context.apps.secret(name, "clientId"),
          LINEAR_CLIENT_SECRET: context.apps.secret(name, "clientSecret"),
        };
      },
    };
  },
};
