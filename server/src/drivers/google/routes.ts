import { z } from "@hono/zod-openapi";

import { BUILT_IN_APP } from "../../core/apps/index.ts";
import type { DeliveryRecord } from "../../core/delivery/index.ts";
import { registerEmailRoutes } from "../../core/email/routes.ts";
import type { EventLog } from "../../core/events/index.ts";
import { DELIVERY_IS_THE_PLATFORMS, type LiveSupport } from "../../core/reality/index.ts";
import { type DeliveryView, type DriverRouter, registerInspectionRoutes } from "../../core/router/index.ts";
import { apiCallSchema, DeliveryAttempt, DeliveryStatus } from "../../core/router/inspect.ts";
import type { GoogleWorld } from "./backend.ts";
import type { FakeGoogleWorld } from "./fake/world.ts";
import { GMAIL_API } from "./live/client.ts";
import type { GoogleAppRecord, GoogleEmailRecord } from "./world.ts";

const GoogleDelivery = z
  .object({
    id: z.string().openapi({ description: "The Pub/Sub message's id." }),
    channel: z.literal("google"),
    /** The app whose push endpoint it went to, by name: `my-agent`, or one a test made. */
    app: z.string(),
    type: z.string().openapi({ description: "`gmail.history`: the mailbox's history moved on." }),
    emailAddress: z.string().openapi({ description: "The mailbox the push is about." }),
    historyId: z.string().openapi({ description: "The mailbox's history id when the push was sent." }),
    payload: z.unknown(),
    attempts: z.array(DeliveryAttempt),
    status: DeliveryStatus,
  })
  .openapi("GoogleDelivery", { "x-channelstack-resource": { id: "id" } });

const GoogleApiCall = apiCallSchema("google", "GoogleApiCall");

/** What only the agent's own calls show: live, proxy mode sees them. */
const AGENT_SIDE: LiveSupport = {
  requires: "proxy",
  reason: "Gmail doesn't report the mailbox's calls; proxy mode sees them",
};
/** Pub/Sub pushes again only what the agent didn't acknowledge. */
const NO_REDELIVERY: LiveSupport = { unsupported: "Pub/Sub has no API to push an acknowledged message again" };

/** The Google driver's control API: what a test's people do, and what a test reads back. */
export function registerGoogleRoutes(
  router: DriverRouter,
  deps: {
    fake: FakeGoogleWorld;
    live: GoogleWorld | undefined;
    world: GoogleWorld;
    events: EventLog;
    apiUrl: () => string;
  },
): void {
  const { fake, world } = deps;
  const { store } = world;
  const stability = "experimental";

  const deliveryWire = ({ request, attempts }: DeliveryView) => ({
    id: request.id,
    channel: "google" as const,
    app: request.app ?? BUILT_IN_APP,
    type: request.type,
    emailAddress: String(request.meta?.emailAddress ?? ""),
    historyId: String(request.meta?.historyId ?? ""),
    payload: request.meta?.payload,
    attempts,
    status: attempts.at(-1)?.status ?? ("pending" as const),
  });

  registerEmailRoutes(router, {
    title: "Google",
    channel: "google",
    world,
    words: {
      app: "mailbox",
      address: "Where people email the agent: its mailbox's address.",
      delivery: "The push that told the agent of it, for an email to it.",
    },
    apiUrl: () => (deps.live ? GMAIL_API : `${new URL(deps.apiUrl()).origin}/`),
    apiUrlDescription: "The root URL to give the agent's `googleapis` client (`GOOGLE_API_URL`, as `rootUrl`).",
    tokenDescription:
      "Live: a refresh token for the person's own Gmail account, from the agent's OAuth client, which sends as them and reads their mail.",
    delivery: {
      schema: GoogleDelivery,
      wire: (session, email: GoogleEmailRecord) =>
        deps.live || email.delivery === undefined
          ? undefined
          : deliveryWire(fake.delivery(session, email.delivery) as DeliveryRecord),
      // The first push to that app's endpoint that told of the email: of its copy in that app's mailbox.
      wireFor: (session, email, app) => {
        const found = fake
          .deliveries(session)
          .find(
            ({ request }) =>
              (request.app ?? BUILT_IN_APP) === app &&
              ((request.meta?.emails as string[] | undefined) ?? []).includes(email.id),
          );
        return found === undefined ? undefined : deliveryWire(found);
      },
    },
    // Every header of the message as it travelled, the sender's own (`Auto-Submitted`) among them.
    headers: (email) => {
      const headers: Record<string, string> = {};
      for (const { name, value } of email.headers) headers[name.toLowerCase()] ??= value;
      return headers;
    },
    apps: {
      options: {},
      fields: {
        shape: {
          clientId: z
            .string()
            .openapi({ description: "Its OAuth client's id (`GOOGLE_CLIENT_ID`). Fake only: empty live." }),
          clientSecret: z
            .string()
            .openapi({ description: "Its OAuth client's secret (`GOOGLE_CLIENT_SECRET`). Fake only: empty live." }),
          refreshToken: z
            .string()
            .openapi({ description: "Its mailbox's refresh token (`GOOGLE_REFRESH_TOKEN`). Fake only: empty live." }),
        },
        // A live mailbox's credentials stay on the server: the control API never returns them.
        wire: (app: GoogleAppRecord) =>
          deps.live ? { clientId: "", clientSecret: "", refreshToken: "" } : fake.credentials(app),
      },
      create: (session, input) => fake.createApp(session, { name: input.name }),
      send: (session, app, input) => fake.sendAs(session, app, input),
      reply: (session, app, to, input) => fake.replyAs(session, app, to, input),
    },
    emailFields: {
      shape: {
        labels: z.array(z.string()).openapi({
          description:
            "Its labels in the agent's mailbox (`INBOX`, `UNREAD`, `SENT`, the agent's own), for an email the agent has.",
        }),
      },
      wire: (email) => ({ labels: [...world.labelsOf(email)] }),
    },
  });

  // --- Deliveries and calls -------------------------------------------------------------------

  registerInspectionRoutes(router, {
    title: "Google",
    events: deps.events,
    stability,
    deliveries: fake,
    delivery: { schema: GoogleDelivery, wire: deliveryWire },
    listSummary: "Every push channelstack sent the agent for this session, with every attempt",
    filters: {
      type: "Only this kind: `gmail.history`.",
      resource: {
        description: "Only pushes that told of an email in this thread.",
        ref: "GoogleThread",
        matches: ({ request }, thread) =>
          ((request.meta?.emails as string[] | undefined) ?? []).some(
            (email) => store.emails.find(email)?.thread === thread,
          ),
      },
    },
    live: { reads: DELIVERY_IS_THE_PLATFORMS, redeliver: NO_REDELIVERY },
    redeliver: {
      summary: "Push the same message again, as Pub/Sub does when a push isn't acknowledged: the same message id",
    },
    resend: {
      summary:
        "Push it again, forged: with a token signed by another key, one that has expired, or one for another audience than the push endpoint",
      options: ["badSignature", "stale", "wrongAudience"],
    },
    calls: {
      schema: GoogleApiCall,
      summary:
        "The Gmail calls the agent made about this session's mail, by the SDK's method name (`users.messages.send`)",
      live: AGENT_SIDE,
    },
  });
}
