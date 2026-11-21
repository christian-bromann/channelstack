import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { createSlackFake } from "./fake/index.ts";
import { registerSlackRoutes } from "./routes.ts";

/** The Slack driver: the fake Web API and Events API, and the control actions a test's people take. */
export const slack: DriverDefinition = {
  name: "slack",
  secrets: {
    botToken: "slack.botToken",
    appToken: "slack.appToken",
    signingSecret: "slack.signingSecret",
    verificationToken: "slack.verificationToken",
  },
  create(context): Driver {
    const fake = createSlackFake(context);
    return {
      name: "slack",
      fake,
      routes: (router) =>
        registerSlackRoutes(router, {
          world: fake.world,
          events: context.events,
          apiUrl: context.apiUrl,
          secret: context.secret,
        }),
      capabilities: () => ({}),
      // A stream the app started and hasn't stopped is work in progress.
      openWork: (session) =>
        fake.store
          .conversationsOf(session)
          .flatMap((conversation) => fake.store.messagesIn(conversation.id))
          .filter((message) => message.stream?.state === "open").length,
      env: () => ({
        SLACK_API_URL: `${context.apiUrl()}/api/`,
        SLACK_BOT_TOKEN: context.secret("botToken"),
        SLACK_APP_TOKEN: context.secret("appToken"),
        SLACK_SIGNING_SECRET: context.secret("signingSecret"),
      }),
    };
  },
};
