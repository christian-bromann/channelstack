import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { createSlackFake } from "./fake/index.ts";
import { registerSlackRoutes } from "./routes.ts";

/** The start of a text, short enough for one line of a failure message. */
const excerpt = (text: string): string => {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

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
          .filter((message) => message.stream?.state === "open")
          .map((message) => `a stream ${fake.store.app.name} started and never stopped: "${excerpt(message.text)}"`),
      env: () => ({
        SLACK_API_URL: `${context.apiUrl()}/api/`,
        SLACK_BOT_TOKEN: context.secret("botToken"),
        SLACK_APP_TOKEN: context.secret("appToken"),
        SLACK_SIGNING_SECRET: context.secret("signingSecret"),
      }),
    };
  },
};
