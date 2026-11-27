import { BUILT_IN_APP } from "../../core/apps/index.ts";
import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { capabilities } from "./capabilities.ts";
import { createEchoFake } from "./fake/index.ts";
import { ECHO_IDS } from "./ids.ts";
import { registerEchoRoutes } from "./routes.ts";
import { ECHO_SECRETS } from "./secrets.ts";

/**
 * The echo driver: a minimal platform of channelstack's own (people, rooms, messages) that takes
 * the same path through the server as a real channel. It proves the pipeline; see decision 0003.
 */
export const echo: DriverDefinition = {
  name: "echo",
  title: "Echo",
  ids: ECHO_IDS,
  tokenPatterns: [/echo_app_[A-Za-z0-9]{20,}/g],
  internal: true,
  secrets: { appToken: ECHO_SECRETS.appToken, signingSecret: ECHO_SECRETS.signingSecret },
  create(context): Driver {
    const fake = createEchoFake(context);
    /** An app asked for by name before any test made it. */
    const makeApp = (name: string) => fake.world.createApp(undefined, { name }).name;
    return {
      name: "echo",
      fake,
      routes: (router) => registerEchoRoutes(router, { world: fake.world, apiUrl: context.apiUrl, capabilities }),
      capabilities: () => capabilities,
      openWork: () => [],
      // Another app's lines have the built-in app's keys (decision 0027).
      env: (app) => {
        const name =
          app === undefined ? BUILT_IN_APP : fake.world.apps().find((one) => one.name === app) ? app : makeApp(app);
        return {
          ECHO_API_URL: context.apiUrl(),
          ECHO_APP_TOKEN: context.apps.secret(name, "appToken"),
          ECHO_SIGNING_SECRET: context.apps.secret(name, "signingSecret"),
        };
      },
    };
  },
};
