import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { fakeGoogleWorld } from "./backend.ts";
import { createGoogleFake } from "./fake/index.ts";
import { PUBSUB } from "./fake/world.ts";
import { GOOGLE_IDS } from "./ids.ts";
import { registerGoogleRoutes } from "./routes.ts";
import { GOOGLE_SECRETS } from "./secrets.ts";

/** The Google driver: Gmail's API, Google's token endpoint and certificates, and Pub/Sub's pushes. */
export const google: DriverDefinition = {
  name: "google",
  title: "Google",
  ids: GOOGLE_IDS,
  tokenPatterns: [/ya29\.[A-Za-z0-9_-]{20,}/g, /1\/\/0[A-Za-z0-9_-]{40,}/g, /GOCSPX-[A-Za-z0-9_-]{28}/g],
  // Gmail's API, Google's token endpoint, and where its certificates are.
  hosts: ["gmail.googleapis.com", "oauth2.googleapis.com", "www.googleapis.com"],
  // googleapis keeps its paths at the root of the `rootUrl` it is given.
  rootPaths: ["/gmail/v1/", "/upload/gmail/v1/"],
  secrets: {
    clientId: GOOGLE_SECRETS.clientId,
    clientSecret: GOOGLE_SECRETS.clientSecret,
    refreshToken: GOOGLE_SECRETS.refreshToken,
    pushKey: GOOGLE_SECRETS.pushKey,
  },
  create(context): Driver {
    const fake = createGoogleFake(context);
    const world = fakeGoogleWorld(fake.world);
    return {
      name: "google",
      fake,
      routes: (router) =>
        registerGoogleRoutes(router, {
          fake: fake.world,
          live: undefined,
          world,
          events: context.events,
          apiUrl: context.apiUrl,
        }),
      capabilities: () => ({}),
      openWork: () => [],
      // What the agent needs: `googleapis` takes `rootUrl` per API, `google-auth-library` its endpoints.
      env: () => {
        const url = context.apiUrl();
        return {
          // `googleapis` drops a `rootUrl`'s path: the root of the fake's host (rootPaths).
          GOOGLE_API_URL: `${new URL(url).origin}/`,
          GOOGLE_TOKEN_URL: `${url}/token`,
          GOOGLE_CERTS_URL: `${url}/oauth2/v1/certs`,
          GOOGLE_CLIENT_ID: context.secret("clientId"),
          GOOGLE_CLIENT_SECRET: context.secret("clientSecret"),
          GOOGLE_REFRESH_TOKEN: context.secret("refreshToken"),
          GMAIL_ADDRESS: fake.store.app.address,
          GOOGLE_PUBSUB_TOPIC: PUBSUB.topic,
          GOOGLE_PUSH_SERVICE_ACCOUNT: PUBSUB.serviceAccount,
          // The audience Pub/Sub's tokens are for: the push endpoint, as a subscription's default.
          ...(context.webhookUrl === undefined ? {} : { GOOGLE_PUSH_AUDIENCE: context.webhookUrl }),
        };
      },
    };
  },
};
