import { z } from "@hono/zod-openapi";

import { BUILT_IN_APP } from "../../core/apps/index.ts";
import type { DeliveryRecord } from "../../core/delivery/index.ts";
import { registerEmailRoutes } from "../../core/email/routes.ts";
import type { EventLog } from "../../core/events/index.ts";
import { DELIVERY_IS_THE_PLATFORMS, type LiveSupport } from "../../core/reality/index.ts";
import { type DeliveryView, type DriverRouter, registerInspectionRoutes } from "../../core/router/index.ts";
import { apiCallSchema, DeliveryAttempt, DeliveryStatus } from "../../core/router/inspect.ts";
import type { ResendWorld } from "./backend.ts";
import type { FakeResendWorld } from "./fake/world.ts";
import { RESEND_API } from "./live/client.ts";
import type { ResendAppRecord, ResendEmailRecord } from "./world.ts";

const ResendDelivery = z
  .object({
    id: z.string().openapi({ description: "The webhook message's id (`svix-id`)." }),
    channel: z.literal("resend"),
    /** The app whose team's webhook it went to, by name: `my-agent`, or one a test made. */
    app: z.string(),
    type: z.string().openapi({ description: "`email.received`, `email.sent`, `email.delivered`, `email.bounced`, …" }),
    email: z.string().openapi({ description: "The email the event is about." }),
    payload: z.unknown(),
    attempts: z.array(DeliveryAttempt),
    status: DeliveryStatus,
  })
  .openapi("ResendDelivery", { "x-channelstack-resource": { id: "id" } });

const ResendApiCall = apiCallSchema("resend", "ResendApiCall");

/** What only the agent's own calls show: live, proxy mode sees them. */
const AGENT_SIDE: LiveSupport = {
  requires: "proxy",
  reason: "Resend doesn't report the team's calls; proxy mode sees them",
};
/** Resend replays a webhook only from its dashboard. */
const NO_REDELIVERY: LiveSupport = { unsupported: "Resend has no API to redeliver a webhook" };

/** The Resend driver's control API: what a test's people do, and what a test reads back. */
export function registerResendRoutes(
  router: DriverRouter,
  deps: {
    fake: FakeResendWorld;
    live: ResendWorld | undefined;
    world: ResendWorld;
    events: EventLog;
    apiUrl: () => string;
  },
): void {
  const { fake, world } = deps;
  const stability = "experimental";

  const deliveryWire = ({ request, attempts }: DeliveryView) => ({
    id: request.id,
    channel: "resend" as const,
    app: request.app ?? BUILT_IN_APP,
    type: request.type,
    email: String(request.meta?.email ?? ""),
    payload: request.meta?.payload,
    attempts,
    status: attempts.at(-1)?.status ?? ("pending" as const),
  });

  registerEmailRoutes(router, {
    title: "Resend",
    channel: "resend",
    world,
    words: {
      app: "team",
      address: "Where people email the agent: its team's receiving address.",
      delivery: "The `email.received` webhook that told the agent, for an email to it.",
    },
    apiUrl: () => (deps.live ? RESEND_API : deps.apiUrl()),
    apiUrlDescription: "The base URL to give the agent: `RESEND_BASE_URL`.",
    tokenDescription: "Live: an API key of the person's own Resend team, which sends as them and reads their mail.",
    delivery: {
      schema: ResendDelivery,
      wire: (session, email: ResendEmailRecord) =>
        deps.live || email.delivery === undefined
          ? undefined
          : deliveryWire(fake.delivery(session, email.delivery) as DeliveryRecord),
      // The first webhook the email caused at that app's team: `email.received`, or for its sender `email.sent`.
      wireFor: (session, email, app) => {
        const found = fake
          .deliveries(session)
          .find(({ request }) => (request.app ?? BUILT_IN_APP) === app && request.meta?.email === email.id);
        return found === undefined ? undefined : deliveryWire(found);
      },
    },
    // What the sender set itself: the agent's own headers (`Auto-Submitted`), by lower-case name.
    headers: (email) =>
      Object.fromEntries(Object.entries(email.headers).map(([name, value]) => [name.toLowerCase(), value])),
    apps: {
      options: {
        domain: z.string().optional().openapi({
          description:
            "The team's receiving domain, which no other team has. Default `<name>.acme.example`; its address is `<name>@<domain>`.",
        }),
      },
      fields: {
        shape: {
          domain: z.string().openapi({ description: "The team's domain: it sends and receives there." }),
          apiKey: z.string().openapi({ description: "The team's API key (`RESEND_API_KEY`). Fake only: empty live." }),
          webhookSecret: z
            .string()
            .openapi({ description: "Its webhook's signing secret (`RESEND_WEBHOOK_SECRET`). Fake only: empty live." }),
        },
        // A live team's key stays on the server: the control API never returns it.
        wire: (app: ResendAppRecord) => ({
          domain: app.domain,
          ...(deps.live ? { apiKey: "", webhookSecret: "" } : fake.credentials(app)),
        }),
      },
      create: (session, input) =>
        fake.createApp(session, { name: input.name, domain: input.domain as string | undefined }),
      send: (session, app, input) => fake.sendAs(session, app, input),
      reply: (session, app, to, input) => fake.replyAs(session, app, to, input),
    },
  });

  // --- Deliveries and calls -------------------------------------------------------------------

  registerInspectionRoutes(router, {
    title: "Resend",
    events: deps.events,
    stability,
    deliveries: fake,
    delivery: { schema: ResendDelivery, wire: deliveryWire },
    apps: { handle: "ResendApp", roster: world.store.apps },
    listSummary: "Every webhook channelstack sent the agent for this session, with every attempt",
    filters: {
      type: "Only this event type, e.g. `email.received`.",
      resource: {
        description: "Only deliveries about this thread.",
        ref: "ResendThread",
        matches: ({ request }, thread) => request.meta?.thread === thread,
      },
    },
    live: { reads: DELIVERY_IS_THE_PLATFORMS, redeliver: NO_REDELIVERY },
    redeliver: { summary: "Send the same webhook again, as Resend retries: the same `svix-id`, signed again" },
    resend: {
      summary:
        "Send the webhook again, forged: signed with a secret that isn't the webhook's, or with a timestamp past the five minutes receivers accept",
      options: ["badSignature", "stale"],
    },
    calls: {
      schema: ResendApiCall,
      summary: "The REST calls the agent made about this session's emails, by the SDK's method name (`emails.send`)",
      live: AGENT_SIDE,
    },
  });
}
