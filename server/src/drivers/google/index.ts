import { emailDev } from "../../core/email/dev.ts";
import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { fakeGoogleWorld } from "./backend.ts";
import { createGoogleFake } from "./fake/index.ts";
import { PUBSUB, pubsubOf } from "./fake/world.ts";
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
  dev: emailDev("Google"),
  ids: GOOGLE_IDS,
  tokenPatterns: [/ya29\.[A-Za-z0-9_-]{20,}/g, /1\/\/0[A-Za-z0-9_-]{40,}/g, /GOCSPX-[A-Za-z0-9_-]{28}/g],
  // Gmail's API, Google's token endpoint, and where its certificates are.
  hosts: ["gmail.googleapis.com", "oauth2.googleapis.com", "www.googleapis.com"],
  // googleapis keeps its paths at the root of the `rootUrl` it is given.
  rootPaths: ["/gmail/v1/"],
  secrets: {
    clientId: GOOGLE_SECRETS.clientId,
    clientSecret: GOOGLE_SECRETS.clientSecret,
    refreshToken: GOOGLE_SECRETS.refreshToken,
    pushKey: GOOGLE_SECRETS.pushKey,
  },
  // The token endpoint makes an access token per refresh: none is kept among the secrets.
  liveTokens: [GOOGLE_SECRETS.accessToken],
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
      // A session's threads go to the trash, and its labels are deleted, as the mailbox they are in.
      context.live.ledger.onCleanup("google", async (entry) => {
        const credential = live.credential(entry.by, entry.session);
        if (!credential) throw new Error(`no credential for ${entry.by}`);
        if (entry.kind === "label") await client.deleteLabel(credential, entry.ref.label ?? "");
        else await client.trashThread(credential, entry.ref.thread ?? "");
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
      // Live, `channelstack env` prints nothing for Gmail (app.ts): the agent talks to it with its own configuration.
      // Another app's lines have the built-in app's keys, so its agent starts from an .env of the same shape.
      env: (app) => {
        const mailbox = fake.store.appForEnv(app, (name) => fake.world.createApp(undefined, { name }));
        const url = context.apiUrl();
        const audience = context.apps.webhookUrl(mailbox.name);
        const { clientId, clientSecret, refreshToken } = fake.world.credentials(mailbox);
        return {
          // `googleapis` drops a `rootUrl`'s path: the root of the fake's host (rootPaths).
          GOOGLE_API_URL: `${new URL(url).origin}/`,
          GOOGLE_TOKEN_URL: `${url}/token`,
          GOOGLE_CERTS_URL: `${url}/oauth2/v1/certs`,
          GOOGLE_CLIENT_ID: clientId,
          GOOGLE_CLIENT_SECRET: clientSecret,
          GOOGLE_REFRESH_TOKEN: refreshToken,
          GMAIL_ADDRESS: mailbox.address,
          GOOGLE_PUBSUB_TOPIC: pubsubOf(mailbox.name).topic,
          GOOGLE_PUSH_SERVICE_ACCOUNT: PUBSUB.serviceAccount,
          // The audience Pub/Sub's tokens are for: the app's push endpoint, as a subscription's default.
          ...(audience === undefined ? {} : { GOOGLE_PUSH_AUDIENCE: audience }),
        };
      },
    };
  },
};
