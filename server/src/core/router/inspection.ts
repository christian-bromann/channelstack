import { z } from "@hono/zod-openapi";

import type { DeliveryAttempt as Attempt, DeliveryRecord } from "../delivery/index.ts";
import type { EventLog } from "../events/index.ts";
import { DELIVERY_IS_THE_PLATFORMS, type LiveSupport } from "../reality/index.ts";
import { CallsQuery, DeliveryAttempt, readCalls } from "./inspect.ts";
import type { DriverRouter } from "./route.ts";

/** A value now (the fake), or once a live platform has answered. */
export type Awaitable<T> = T | Promise<T>;

/** `x-channelstack-ref`: this string is the id of one of these handles, so the SDKs take the handle. */
export const refTo = (...resources: string[]) => ({ "x-channelstack-ref": resources });

/** A path parameter of the control API. */
export const pathParam = (name: string) => z.string().openapi({ param: { name, in: "path" } });

/** What a test may forge on a delivery it sends again (`delivery.resend()`). */
/** How a channel lets a test forge a delivery: a bad signature, a stale one, a token for another audience (Pub/Sub), extra headers. */
type ForgeOption = "badSignature" | "stale" | "wrongAudience" | "headers";

/** What the routes read of a delivery: the fake's whole record, or what a live platform's log says (GitHub's). */
export type DeliveryView = Pick<DeliveryRecord, "attempts"> & {
  request: Pick<DeliveryRecord["request"], "id" | "type" | "meta">;
};

/** A channel's deliveries, as its routes read and resend them: the fake's, or a live platform's log. */
interface InspectedDeliveries {
  deliveries(session: string): Awaitable<DeliveryView[]>;
  delivery(session: string, id: string): Awaitable<DeliveryView>;
  /** Needed unless the channel registers its own redelivery (`redeliver: false`). */
  redeliver?(session: string, id: string): Awaitable<Attempt>;
  resend(
    session: string,
    id: string,
    options: {
      badSignature: boolean;
      stale?: boolean;
      wrongAudience?: boolean;
      headers?: Record<string, string> | undefined;
    },
  ): Awaitable<Attempt>;
}

/**
 * What a channel's inspection routes say and do, which is all that differs between channels: the
 * channel's own words for its deliveries and calls, its delivery schema and filters, and what works live.
 */
export interface InspectionSpec<Wire> {
  /** The channel's type prefix: `Notion` makes `NotionFixture`, `NotionDelivery`, `NotionResendBody`. */
  readonly title: string;
  readonly events: EventLog;
  readonly stability: "experimental" | "stable";
  readonly deliveries: InspectedDeliveries;
  /** The channel's delivery handle, and how a delivery becomes one. */
  readonly delivery: { readonly schema: z.ZodType<Wire>; wire(record: DeliveryView): Wire };
  /** What `/deliveries` says it lists: "Every webhook channelstack sent the agent…". */
  readonly listSummary: string;
  /** Filters of `/deliveries`: by event type, and by the resource a delivery is about. None for a channel without them. */
  readonly filters?: {
    /** "Only this event type, e.g. `comment.created`." */
    readonly type: string;
    readonly resource: {
      /** "Only deliveries about this page." */
      readonly description: string;
      /** The handle the resource id is of (`NotionPage`). */
      readonly ref: string;
      matches(record: DeliveryView, resource: string): boolean;
    };
  };
  /** What live mode does with reads, redelivery and resending. Reads default to `DELIVERY_IS_THE_PLATFORMS`. */
  readonly live?: {
    /** Undefined: the routes read a live platform's own log (GitHub's App delivery log). */
    readonly reads?: LiveSupport | undefined;
    readonly redeliver?: LiveSupport | undefined;
  };
  /**
   * Redelivering as the platform does (`/deliveries/{delivery}/redeliver`), with what it says it
   * does. `false` for a platform whose own word for it takes other options (Slack's `retry`), whose
   * driver registers it.
   */
  readonly redeliver: { readonly summary: string } | false;
  /** Sending a delivery again, forged: what it says, and what a test may forge. */
  readonly resend: { readonly summary: string; readonly options: readonly ForgeOption[] };
  /** The agent's API calls: their schema, what `/calls` says, and why live needs proxy mode. */
  readonly calls: { readonly schema: z.ZodType; readonly summary: string; readonly live: LiveSupport };
}

/**
 * The routes every channel has for what a test inspects: its deliveries (list, re-read, redeliver,
 * resend) and the agent's API calls. Written once; each channel passes only what differs.
 */
export function registerInspectionRoutes<Wire>(router: DriverRouter, spec: InspectionSpec<Wire>): void {
  const { title, stability, deliveries } = spec;
  const fixture = `${title}Fixture`;
  const handle = `${title}Delivery`;
  const reads = spec.live && "reads" in spec.live ? spec.live.reads : DELIVERY_IS_THE_PLATFORMS;
  const live = (support: LiveSupport | undefined) => (support === undefined ? {} : { live: support });
  const DeliveryParams = z.object({ delivery: pathParam("delivery") });

  const { filters } = spec;
  if (filters) {
    router.route({
      method: "get",
      path: "/deliveries",
      summary: spec.listSummary,
      query: z.object({
        type: z
          .string()
          .optional()
          .openapi({ param: { name: "type", in: "query" }, description: filters.type }),
        resource: z
          .string()
          .optional()
          .openapi({
            param: { name: "resource", in: "query" },
            description: filters.resource.description,
            ...refTo(filters.resource.ref),
          }),
      }),
      response: z.array(spec.delivery.schema).openapi(`${title}Deliveries`),
      sdkMethod: { on: fixture, name: "deliveries", options: ["type", "resource"] },
      ...live(reads),
      stability,
      handler: async ({ session, query }) =>
        (await deliveries.deliveries(session.id))
          .filter(({ request }) => query.type === undefined || request.type === query.type)
          .filter((record) => query.resource === undefined || filters.resource.matches(record, query.resource))
          .map(spec.delivery.wire),
    });
  } else {
    router.route({
      method: "get",
      path: "/deliveries",
      summary: spec.listSummary,
      response: z.array(spec.delivery.schema).openapi(`${title}Deliveries`),
      sdkMethod: { on: fixture, name: "deliveries" },
      ...live(reads),
      stability,
      handler: async ({ session }) => (await deliveries.deliveries(session.id)).map(spec.delivery.wire),
    });
  }

  router.route({
    method: "get",
    path: "/deliveries/{delivery}",
    summary: "Re-read a delivery: its attempts and status",
    params: DeliveryParams,
    response: spec.delivery.schema,
    errors: ["not_found"],
    sdkMethod: { on: handle, name: "refresh" },
    waits: [{ name: "settled", mode: "until", field: "status", not: ["pending"], what: "the delivery to settle" }],
    ...live(reads),
    stability,
    handler: async ({ session, params }) => spec.delivery.wire(await deliveries.delivery(session.id, params.delivery)),
  });

  const { redeliver } = deliveries;
  if (spec.redeliver) {
    if (!redeliver) throw new Error(`${title}'s inspection routes redeliver, but its deliveries can't`);
    router.route({
      method: "post",
      path: "/deliveries/{delivery}/redeliver",
      summary: spec.redeliver.summary,
      params: DeliveryParams,
      response: DeliveryAttempt,
      errors: ["not_found"],
      sdkMethod: { on: handle, name: "redeliver" },
      ...live(spec.live?.redeliver),
      stability,
      handler: ({ session, params }) => redeliver(session.id, params.delivery),
    });
  }

  const forge = spec.resend.options;
  router.route({
    method: "post",
    path: "/deliveries/{delivery}/resend",
    summary: spec.resend.summary,
    params: DeliveryParams,
    body: z
      .object({
        badSignature: z.boolean().default(false),
        ...(forge.includes("stale") ? { stale: z.boolean().default(false) } : {}),
        ...(forge.includes("wrongAudience") ? { wrongAudience: z.boolean().default(false) } : {}),
        ...(forge.includes("headers") ? { headers: z.record(z.string(), z.string()).optional() } : {}),
      })
      .openapi(`${title}ResendBody`),
    response: DeliveryAttempt,
    errors: ["not_found"],
    sdkMethod: { on: handle, name: "resend", options: [...forge] },
    live: DELIVERY_IS_THE_PLATFORMS,
    stability,
    handler: ({ session, params, body }) =>
      deliveries.resend(
        session.id,
        params.delivery,
        body as { badSignature: boolean; stale?: boolean; wrongAudience?: boolean; headers?: Record<string, string> },
      ),
  });

  router.route({
    method: "get",
    path: "/calls",
    summary: spec.calls.summary,
    query: CallsQuery,
    response: z.array(spec.calls.schema).openapi(`${title}ApiCalls`),
    sdkMethod: { on: fixture, name: "calls", options: ["operation", "error"] },
    waits: [{ name: "waitForCall", mode: "next", filter: true, what: "an API call from the agent" }],
    live: spec.calls.live,
    stability,
    handler: ({ session, query }) => readCalls(spec.events, session.id, router.driver, query),
  });
}
