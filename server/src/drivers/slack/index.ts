import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { createSlackFake } from "./fake/index.ts";
import { removeSlackEntry } from "./live/cleanup.ts";
import { SlackWebClient } from "./live/client.ts";
import { slackMaintenance } from "./live/maintenance.ts";
import { createLiveWorld } from "./live/world.ts";
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
  // A real app in a sandbox workspace (live-mode.md, section 4). People bring their own tokens.
  live: {
    credentials: ["CHANNELSTACK_SLACK_APP_ID", "CHANNELSTACK_SLACK_BOT_TOKEN"],
    allowlist: "CHANNELSTACK_LIVE_SLACK_TEAMS",
    maintenance: slackMaintenance,
  },
  create(context): Driver {
    const fake = createSlackFake(context);
    const client = new SlackWebClient({
      base: context.live.apiBase,
      fetch: context.live.fetch,
      timers: context.timers,
    });
    const live = context.live.active
      ? createLiveWorld({
          client,
          live: context.live,
          ids: context.ids,
          clock: context.clock,
          timers: context.timers,
          log: context.log,
          appName: fake.store.app.name,
        })
      : undefined;
    if (live) {
      context.live.ledger.onCleanup("slack", (entry) =>
        removeSlackEntry(client, live.credentials(entry.session), entry),
      );
    }
    return {
      name: "slack",
      fake,
      ...(live ? { live } : {}),
      routes: (router) =>
        registerSlackRoutes(router, {
          fake: fake.world,
          live,
          reality: () => (live ? "live" : "fake"),
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
      // Live, the agent talks to Slack with its own configuration, and live credentials never leave the server.
      env: () =>
        live
          ? {}
          : {
              SLACK_API_URL: `${context.apiUrl()}/api/`,
              SLACK_BOT_TOKEN: context.secret("botToken"),
              SLACK_APP_TOKEN: context.secret("appToken"),
              SLACK_SIGNING_SECRET: context.secret("signingSecret"),
            },
    };
  },
};
