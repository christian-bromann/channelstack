import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { capabilities } from "./capabilities.ts";
import { createEchoFake } from "./fake/index.ts";
import { registerEchoRoutes } from "./routes.ts";

/**
 * The echo driver: a minimal platform of channelstack's own (people, rooms, messages) that takes
 * the same path through the server as a real channel. It proves the pipeline; see decision 0003.
 */
export const echo: DriverDefinition = {
  name: "echo",
  title: "Echo",
  internal: true,
  secrets: { appToken: "echo.appToken", signingSecret: "echo.signingSecret" },
  create(context): Driver {
    const fake = createEchoFake(context);
    return {
      name: "echo",
      fake,
      routes: (router) => registerEchoRoutes(router, { world: fake.world, apiUrl: context.apiUrl, capabilities }),
      capabilities: () => capabilities,
      openWork: () => [],
      env: () => ({
        ECHO_API_URL: context.apiUrl(),
        ECHO_APP_TOKEN: context.secret("appToken"),
        ECHO_SIGNING_SECRET: context.secret("signingSecret"),
      }),
    };
  },
};
