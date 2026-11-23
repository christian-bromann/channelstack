import { z } from "@hono/zod-openapi";

import type { EventLog } from "../events/index.ts";

/**
 * What every channel's fixture lets a test inspect, in one shape for all of them: deliveries with
 * their attempts, and the API calls the agent made (`Inspectable` in api/common.d.ts).
 */
export const DeliveryStatus = z.enum(["pending", "acknowledged", "failed", "timed_out", "unreachable"]);

export const DeliveryAttempt = z
  .object({
    number: z.number().int(),
    sentAt: z.string(),
    transport: z.enum(["http", "socket"]),
    url: z.string().optional(),
    requestHeaders: z.record(z.string(), z.string()),
    status: DeliveryStatus,
    responseStatus: z.number().int().optional(),
    responseBody: z.string().optional(),
    durationMs: z.number().optional(),
    forgedSignature: z.boolean(),
  })
  .openapi("DeliveryAttempt");

/** A length of time in a request: SDKs take `"3s"` or milliseconds and send milliseconds. */
export const duration = (description: string) =>
  z.number().int().min(0).openapi({ description, "x-channelstack-duration": true });

/** One API call of the agent, as a channel's `calls()` lists it. `name` is the schema's name: `SlackApiCall`. */
export const apiCallSchema = <Channel extends string>(channel: Channel, name: string) =>
  z
    .object({
      id: z.string(),
      channel: z.literal(channel),
      operation: z.string(),
      method: z.string(),
      path: z.string(),
      at: z.string(),
      durationMs: z.number(),
      request: z.unknown(),
      responseStatus: z.number().int(),
      response: z.unknown(),
      error: z.string().optional(),
    })
    .openapi(name);

/** The filter of `calls()`: one operation, and calls that failed (any error, or one error code). */
export const CallsQuery = z.object({
  operation: z
    .string()
    .optional()
    .openapi({ param: { name: "operation", in: "query" } }),
  // In the query it is text either way; the union is what the SDKs accept: `true` or a code.
  error: z
    .union([z.literal(true), z.string()])
    .optional()
    .openapi({ param: { name: "error", in: "query" }, description: "`true` for any error, or one error code" }),
});

/** The agent's API calls to one channel that a session has on record, filtered. */
export function readCalls<Channel extends string>(
  events: EventLog,
  session: string,
  channel: Channel,
  query: z.infer<typeof CallsQuery>,
) {
  return events
    .read(session)
    .events.map((event, index) => ({ event, id: `call_${index + 1}` }))
    .filter(({ event }) => event.kind === "api_call" && event.driver === channel)
    .map(({ event, id }) => ({
      ...(event.data as {
        operation: string;
        method: string;
        path: string;
        durationMs: number;
        request: unknown;
        responseStatus: number;
        response: unknown;
        error?: string;
      }),
      id,
      channel,
      at: event.at,
    }))
    .filter((call) => query.operation === undefined || call.operation === query.operation)
    .filter(
      (call) =>
        query.error === undefined || (query.error === "true" ? call.error !== undefined : call.error === query.error),
    );
}
