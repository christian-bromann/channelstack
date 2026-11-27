import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { fakeTwilioWorld } from "./backend.ts";
import { createTwilioFake } from "./fake/index.ts";
import { TWILIO_IDS } from "./ids.ts";
import { registerTwilioRoutes } from "./routes.ts";
import { TWILIO_PERSON_TOKEN, TWILIO_SECRETS } from "./secrets.ts";

/** The Twilio driver: the fake Messaging API, its signed webhooks and status callbacks, and the texts a test's people send. */
export const twilio: DriverDefinition = {
  name: "twilio",
  title: "Twilio",
  ids: TWILIO_IDS,
  // A key and its secret as one credential (`AC…:…`). The Auth Token and the key's secret have no
  // shape of their own: they are scrubbed by value, once loaded.
  tokenPatterns: [/\b(?:AC|SK)[0-9a-f]{32}:[0-9A-Za-z]{32}\b/g],
  liveTokens: [TWILIO_PERSON_TOKEN],
  hosts: ["api.twilio.com"],
  secrets: {
    authToken: TWILIO_SECRETS.authToken,
    apiKeySecret: TWILIO_SECRETS.apiKeySecret,
    testAuthToken: TWILIO_SECRETS.testAuthToken,
  },
  create(context): Driver {
    const fake = createTwilioFake(context);
    const world = fakeTwilioWorld(fake.world);
    return {
      name: "twilio",
      fake,
      routes: (router) =>
        registerTwilioRoutes(router, {
          fake: fake.world,
          live: undefined,
          world,
          events: context.events,
          apiUrl: context.apiUrl,
        }),
      capabilities: () => ({}),
      openWork: () => [],
      // What the agent needs: `twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)`, its number, and where
      // its client's `https://api.twilio.com` goes. The test credentials too, for an agent's own tests.
      env: () => ({
        TWILIO_API_URL: context.apiUrl(),
        TWILIO_ACCOUNT_SID: fake.store.app.accountSid,
        TWILIO_AUTH_TOKEN: context.secret("authToken"),
        TWILIO_API_KEY: fake.keys.apiKeySid,
        TWILIO_API_SECRET: context.secret("apiKeySecret"),
        TWILIO_PHONE_NUMBER: fake.store.app.number,
        TWILIO_MESSAGING_SERVICE_SID: fake.store.app.messagingServiceSid,
        TWILIO_TEST_ACCOUNT_SID: fake.keys.testAccountSid,
        TWILIO_TEST_AUTH_TOKEN: context.secret("testAuthToken"),
      }),
    };
  },
};
