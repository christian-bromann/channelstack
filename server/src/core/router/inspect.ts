import { z } from "@hono/zod-openapi";

import { type EventLog, WORLD_SCOPE } from "../events/index.ts";

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

/** One API call of the agent as a fake puts it on record. `readCalls` reads it back. */
export interface ApiCallRecord {
  /** The platform's name for it: Slack's method, `POST /repos/{owner}/{repo}/issues`, a GraphQL root field, a client method. */
  operation: string;
  method: string;
  path: string;
  request: unknown;
  responseStatus: number;
  response: unknown;
  /** The platform's error code, for a call it refused. */
  error?: string | undefined;
  durationMs: number;
}

/** How much of a request or an answer the event log keeps: a larger one is left out of the record. */
const RECORD_LIMIT = 64 * 1024;
const kept = (value: unknown) =>
  value === undefined || JSON.stringify(value).length > RECORD_LIMIT ? undefined : value;

/**
 * Put an API call on record for the test sessions whose objects it read or changed: the one place
 * a fake writes one. A call about no session's objects is kept for no session (`WORLD_SCOPE`,
 * which every session reads) with `unattributed: "world"`, or not at all with `"drop"`.
 */
export function recordCall(
  events: EventLog,
  channel: string,
  sessions: Iterable<string | undefined>,
  call: ApiCallRecord,
  options: { unattributed: "world" | "drop" },
): void {
  const owners = new Set([...sessions].filter((session): session is string => session !== undefined));
  if (owners.size === 0 && options.unattributed === "world") owners.add(WORLD_SCOPE);
  const record = {
    ...call,
    request: kept(call.request),
    response: kept(call.response),
    ...(call.error === undefined ? {} : { error: call.error }),
  };
  for (const session of owners) events.append(session, channel, "api_call", record);
}

/** Who wrote a line of a transcript. */
export interface TranscriptPrincipal {
  id: string;
  name: string;
  kind: "user" | "app";
}

/** One line of a transcript, in the shape every channel's transcript has (`api/common.d.ts`). */
export interface TranscriptEntry {
  id: string;
  author: TranscriptPrincipal;
  at: string;
  text: string;
  controls: string[];
  edited: boolean;
  depth: number;
}

/** Who wrote a line, as a channel's schema names it (`SlackPrincipal`). */
export const principalSchema = (name: string) =>
  z.object({ id: z.string(), name: z.string(), kind: z.enum(["user", "app"]) }).openapi(name);

/**
 * A channel's transcript schema (`SlackTranscript`, its entries `SlackTranscriptEntry`): every
 * channel's entry fields, and the fields a channel adds (`extra`). SDKs read it as text too.
 */
export function transcriptSchema<Extra extends z.ZodRawShape = Record<never, never>>(
  prefix: string,
  principal: z.ZodType<TranscriptPrincipal>,
  extra: Extra = {} as Extra,
) {
  return z
    .object({
      entries: z.array(
        z
          .object({
            id: z.string(),
            author: principal,
            at: z.string(),
            text: z.string(),
            controls: z.array(z.string()),
            edited: z.boolean(),
            depth: z.number().int(),
            ...extra,
          })
          .openapi(`${prefix}TranscriptEntry`),
      ),
      text: z.string().openapi({ description: "The transcript as plain text, one entry per line." }),
    })
    .openapi(`${prefix}Transcript`, { "x-channelstack-string": "text" });
}

/**
 * A transcript as plain text: a line per entry, indented two spaces per level, `Name: text`, then
 * what `after` adds (Slack's controls) and the entry's marks in parentheses (`edited` by default).
 */
export function transcriptText<Entry extends TranscriptEntry>(
  entries: readonly Entry[],
  options: { marks?: (entry: Entry) => string[]; after?: (entry: Entry) => string } = {},
): string {
  const marks = options.marks ?? ((entry: Entry) => (entry.edited ? ["edited"] : []));
  return entries
    .map((entry) => {
      const named = marks(entry).filter((mark) => mark !== "");
      const suffix = named.length === 0 ? "" : ` (${named.join(", ")})`;
      return `${"  ".repeat(entry.depth)}${entry.author.name}: ${entry.text}${options.after?.(entry) ?? ""}${suffix}`;
    })
    .join("\n");
}
