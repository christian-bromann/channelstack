import { z } from "@hono/zod-openapi";

import type { DeliveryRecord } from "../../core/delivery/index.ts";
import { registerEmailRoutes } from "../../core/email/routes.ts";
import type { EventLog } from "../../core/events/index.ts";
import { DELIVERY_IS_THE_PLATFORMS, type LiveSupport } from "../../core/reality/index.ts";
import { type DeliveryView, type DriverRouter, registerInspectionRoutes } from "../../core/router/index.ts";
import { apiCallSchema, DeliveryAttempt, DeliveryStatus } from "../../core/router/inspect.ts";
import type { ResendWorld } from "./backend.ts";
import type { FakeResendWorld } from "./fake/world.ts";
import { RESEND_API } from "./live/client.ts";
import type { ResendEmailRecord } from "./world.ts";

const ResendDelivery = z
  .object({
    id: z.string().openapi({ description: "The webhook message's id (`svix-id`)." }),
    channel: z.literal("resend"),
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
    },
  });

  // --- Deliveries and calls -------------------------------------------------------------------

  registerInspectionRoutes(router, {
    title: "Resend",
    events: deps.events,
    stability,
    deliveries: fake,
    delivery: { schema: ResendDelivery, wire: deliveryWire },
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
