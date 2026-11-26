import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { fakeGoogleWorld } from "./backend.ts";
import { createGoogleFake } from "./fake/index.ts";
import { PUBSUB } from "./fake/world.ts";
import { GOOGLE_IDS } from "./ids.ts";
import { GoogleRestClient } from "./live/client.ts";
import { googleMaintenance } from "./live/maintenance.ts";
import { createLiveGoogleWorld } from "./live/world.ts";
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
  // The agent's OAuth client and its mailbox's refresh token (live-mode.md, section 4). People bring their own accounts' tokens.
  live: {
    credentials: [
      "CHANNELSTACK_GOOGLE_CLIENT_ID",
      "CHANNELSTACK_GOOGLE_CLIENT_SECRET",
      "CHANNELSTACK_GOOGLE_REFRESH_TOKEN",
    ],
    allowlist: "CHANNELSTACK_LIVE_GOOGLE_ADDRESSES",
    maintenance: googleMaintenance,
  },
  create(context): Driver {
    const fake = createGoogleFake(context);
    const client = new GoogleRestClient({
      base: context.live.apiBase,
      fetch: context.live.fetch,
      timers: context.timers,
      client: () => {
        const secret = context.live.vault.fromEnv("CHANNELSTACK_GOOGLE_CLIENT_SECRET");
        const id = context.live.vault.setting("CHANNELSTACK_GOOGLE_CLIENT_ID");
        if (!secret || !id) throw new Error("The Google OAuth client isn't set");
        return { id, secret };
      },
    });
    const live = context.live.active
      ? createLiveGoogleWorld({ client, live: context.live, clock: context.clock, appName: fake.store.app.name })
      : undefined;
    if (live) {
      // A run's threads go to the trash, as the mailbox they are in.
      context.live.ledger.onCleanup("google", async (entry) => {
        const credential = live.credential(entry.by, entry.session);
        if (!credential) throw new Error(`no credential for ${entry.by}`);
        await client.call(credential, "POST", `gmail/v1/users/me/threads/${entry.ref.thread}/trash`);
      });
    }
    const world = live ?? fakeGoogleWorld(fake.world);
    return {
      name: "google",
      fake,
      ...(live ? { live } : {}),
      routes: (router) =>
        registerGoogleRoutes(router, {
          fake: fake.world,
          live,
          world,
          events: context.events,
          apiUrl: context.apiUrl,
        }),
      capabilities: () => ({}),
      openWork: () => [],
      // What the agent needs: `googleapis` takes `rootUrl` per API, `google-auth-library` its endpoints.
      // Live, the agent talks to Gmail with its own configuration, and live credentials never leave the server.
      env: () => {
        if (live) return {};
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
