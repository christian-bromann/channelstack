import type { Driver, DriverDefinition } from "../../core/router/index.ts";
import { fakeResendWorld } from "./backend.ts";
import { createResendFake } from "./fake/index.ts";
import { RESEND_IDS } from "./ids.ts";
import { registerResendRoutes } from "./routes.ts";
import { RESEND_SECRETS } from "./secrets.ts";

/** The Resend driver: the fake REST API and its Svix-signed webhooks, and the mail a test's people send. */
export const resend: DriverDefinition = {
  name: "resend",
  title: "Resend",
  ids: RESEND_IDS,
  tokenPatterns: [/re_[A-Za-z0-9]{8}_[A-Za-z0-9]{24}/g, /whsec_[A-Za-z0-9+/=]{20,}/g],
  hosts: ["api.resend.com"],
  secrets: { apiKey: RESEND_SECRETS.apiKey, webhookSecret: RESEND_SECRETS.webhookSecret },
  create(context): Driver {
    const fake = createResendFake(context);
    const world = fakeResendWorld(fake.world);
    return {
      name: "resend",
      fake,
      routes: (router) =>
        registerResendRoutes(router, {
          fake: fake.world,
          live: undefined,
          world,
          events: context.events,
          apiUrl: context.apiUrl,
        }),
      capabilities: () => ({}),
      openWork: () => [],
      // What the agent needs: the `resend` SDK reads `RESEND_BASE_URL`; the address is where it sends from.
      env: () => ({
        RESEND_BASE_URL: context.apiUrl(),
        RESEND_API_KEY: context.secret("apiKey"),
        RESEND_WEBHOOK_SECRET: context.secret("webhookSecret"),
        RESEND_FROM: `${fake.store.app.name} <${fake.store.app.address}>`,
      }),
    };
  },
};
