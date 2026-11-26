import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { fakeResendWorld } from "./backend.ts";
import { createResendFake } from "./fake/index.ts";
import { RESEND_IDS } from "./ids.ts";
import { ResendRestClient } from "./live/client.ts";
import { resendMaintenance } from "./live/maintenance.ts";
import { createLiveResendWorld } from "./live/world.ts";
import { registerResendRoutes } from "./routes.ts";
import { RESEND_SECRETS } from "./secrets.ts";

/** The Resend driver: the fake REST API and its Svix-signed webhooks, and the mail a test's people send. */
export const resend: DriverDefinition = {
  name: "resend",
  title: "Resend",
  ids: RESEND_IDS,
  tokenPatterns: [/re_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}/g, /whsec_[A-Za-z0-9+/=]{20,}/g],
  hosts: ["api.resend.com"],
  secrets: {
    apiKey: RESEND_SECRETS.apiKey,
    webhookSecret: RESEND_SECRETS.webhookSecret,
    downloadKey: RESEND_SECRETS.downloadKey,
  },
  // The agent's team's key (live-mode.md, section 4). People bring their own teams' keys.
  live: {
    credentials: ["CHANNELSTACK_RESEND_API_KEY"],
    allowlist: "CHANNELSTACK_LIVE_RESEND_DOMAINS",
    maintenance: resendMaintenance,
  },
  create(context): Driver {
    const fake = createResendFake(context);
    const live = context.live.active
      ? createLiveResendWorld({
          client: new ResendRestClient({
            base: context.live.apiBase,
            fetch: context.live.fetch,
            timers: context.timers,
          }),
          live: context.live,
          clock: context.clock,
          appName: fake.store.app.name,
        })
      : undefined;
    const world = live ?? fakeResendWorld(fake.world);
    return {
      name: "resend",
      fake,
      ...(live ? { live } : {}),
      routes: (router) =>
        registerResendRoutes(router, {
          fake: fake.world,
          live,
          world,
          events: context.events,
          apiUrl: context.apiUrl,
        }),
      capabilities: () => ({}),
      openWork: () => [],
      // What the agent needs: the `resend` SDK reads `RESEND_BASE_URL`; the address is where it sends from.
      // Live, the agent talks to Resend with its own configuration, and live keys never leave the server.
      env: () =>
        live
          ? {}
          : {
              RESEND_BASE_URL: context.apiUrl(),
              RESEND_API_KEY: context.secret("apiKey"),
              RESEND_WEBHOOK_SECRET: context.secret("webhookSecret"),
              RESEND_FROM: `${fake.store.app.name} <${fake.store.app.address}>`,
            },
    };
  },
};
