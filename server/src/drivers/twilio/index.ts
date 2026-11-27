import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { fakeTwilioWorld } from "./backend.ts";
import { createTwilioFake } from "./fake/index.ts";
import { TWILIO_IDS } from "./ids.ts";
import { TwilioRestClient } from "./live/client.ts";
import { deleteMessage, twilioMaintenance } from "./live/maintenance.ts";
import { createLiveTwilioWorld } from "./live/world.ts";
import { registerTwilioRoutes } from "./routes.ts";
import { TWILIO_PERSON_TOKEN, TWILIO_SECRETS } from "./secrets.ts";

/** The Twilio driver: the fake Messaging API, its signed webhooks and status callbacks, and the texts a test's people send. */
export const twilio: DriverDefinition = {
  name: "twilio",
  title: "Twilio",
  ids: TWILIO_IDS,
  // An account and its Auth Token as one credential (`AC…:…`), as a live person's is. The Auth Token
  // and the API key's secret alone have no shape of their own: they are scrubbed by value, once loaded.
  tokenPatterns: [/\bAC[0-9a-f]{32}:[0-9a-f]{32}\b/g],
  liveTokens: [TWILIO_PERSON_TOKEN],
  hosts: ["api.twilio.com"],
  secrets: {
    authToken: TWILIO_SECRETS.authToken,
    apiKeySecret: TWILIO_SECRETS.apiKeySecret,
    testAuthToken: TWILIO_SECRETS.testAuthToken,
  },
  // The agent's account and number (live-mode.md, section 4). People bring the accounts of their numbers.
  live: {
    credentials: ["CHANNELSTACK_TWILIO_ACCOUNT_SID", "CHANNELSTACK_TWILIO_AUTH_TOKEN", "CHANNELSTACK_TWILIO_NUMBER"],
    allowlist: "CHANNELSTACK_LIVE_TWILIO_NUMBERS",
    maintenance: twilioMaintenance,
  },
  create(context): Driver {
    const fake = createTwilioFake(context);
    const client = new TwilioRestClient({
      base: context.live.apiBase,
      fetch: context.live.fetch,
      timers: context.timers,
    });
    const live = context.live.active
      ? createLiveTwilioWorld({ client, live: context.live, clock: context.clock, appName: fake.store.app.name })
      : undefined;
    if (live) {
      // A session's messages are deleted, each with the credential of the account it is on.
      context.live.ledger.onCleanup("twilio", async (entry) => {
        const credential = live.credential(entry.by, entry.session);
        if (!credential) throw new Error(`no credential for ${entry.by}`);
        await deleteMessage(client, credential, entry.ref.sid ?? "");
      });
    }
    const world = live ?? fakeTwilioWorld(fake.world);
    return {
      name: "twilio",
      fake,
      ...(live ? { live } : {}),
      routes: (router) =>
        registerTwilioRoutes(router, {
          fake: fake.world,
          live,
          world,
          events: context.events,
          apiUrl: context.apiUrl,
        }),
      capabilities: () => ({}),
      openWork: () => [],
      // What the agent needs: `twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)`, its number, and where
      // its client's `https://api.twilio.com` goes. The test credentials too, for an agent's own tests.
      // Live, the agent talks to Twilio with its own configuration, and live credentials never leave the server.
      env: () =>
        live
          ? {}
          : {
              TWILIO_API_URL: context.apiUrl(),
              TWILIO_ACCOUNT_SID: fake.store.app.accountSid,
              TWILIO_AUTH_TOKEN: context.secret("authToken"),
              TWILIO_API_KEY: fake.keys.apiKeySid,
              TWILIO_API_SECRET: context.secret("apiKeySecret"),
              TWILIO_PHONE_NUMBER: fake.store.app.number,
              TWILIO_MESSAGING_SERVICE_SID: fake.store.app.messagingServiceSid,
              TWILIO_TEST_ACCOUNT_SID: fake.keys.testAccountSid,
              TWILIO_TEST_AUTH_TOKEN: context.secret("testAuthToken"),
            },
    };
  },
};
