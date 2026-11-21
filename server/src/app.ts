import { OpenAPIHono, z } from "@hono/zod-openapi";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { requireBearer } from "./core/auth/index.ts";
import { type Clock, systemClock } from "./core/clock/index.ts";
import { DeliveryQueue } from "./core/delivery/index.ts";
import { ProtocolError } from "./core/errors/index.ts";
import { EventLog } from "./core/events/index.ts";
import { IdGenerator } from "./core/ids/index.ts";
import type { Logger } from "./core/log/index.ts";
import { QuietDetector } from "./core/quiet/index.ts";
import type { Redactor } from "./core/redact/index.ts";
import { Registry } from "./core/registry/index.ts";
import { type Driver, DriverRouter, invalidArgument, registerRoute, SessionParams } from "./core/router/index.ts";
import type { Secrets } from "./core/secrets/index.ts";
import { Sessions } from "./core/sessions/index.ts";
import { DRIVERS } from "./drivers/index.ts";

export const CONTROL_PREFIX = "/_channelstack";

/** Where the server is reachable: decided by portless or `--no-portless`, and known only once it listens. */
export interface ServerUrls {
  /** UI and control API base, e.g. `https://channelstack.localhost`. */
  control: string;
  /** A driver's fake provider API, e.g. `https://echo.localhost` or `http://127.0.0.1:4500/echo`. */
  driver(name: string): string;
}

export interface AppOptions {
  version: string;
  /** The control API's bearer token. */
  token: string;
  /** Seed for the id generator (`CHANNELSTACK_SEED`). */
  seed: number;
  secrets: Secrets;
  redactor: Redactor;
  log: Logger;
  urls: () => ServerUrls;
  /** The agent's endpoint per driver, for the events that driver delivers. */
  webhooks: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
}

export interface App {
  fetch(request: Request): Response | Promise<Response>;
  /** The control API as an OpenAPI 3.1 document, with the `x-channelstack-*` extensions the SDK generator reads. */
  openapi(): object;
  /** `<name>.localhost` for the control API and every driver. */
  hosts(): string[];
  /** Resolves once no delivery is in flight. */
  settled(): Promise<void>;
}

const Status = z.object({ ready: z.boolean(), version: z.string(), drivers: z.array(z.string()) }).openapi("Status");

const Session = z
  .object({ sessionId: z.string(), drivers: z.array(z.string()) })
  .openapi("Session", { "x-channelstack-resource": { id: "sessionId", scope: "session" } });

const LogEvent = z
  .object({
    at: z.string(),
    driver: z.string(),
    kind: z.enum(["action", "delivery", "delivery_attempt", "api_call"]),
    data: z.record(z.string(), z.unknown()),
  })
  .openapi("LogEvent");

const EventPage = z.object({ events: z.array(LogEvent), cursor: z.string() }).openapi("EventPage");

const Env = z.record(z.string(), z.string()).openapi("Env");

const Quiet = z
  .object({
    busy: z
      .boolean()
      .openapi({ description: "A call from the agent is in flight, a delivery hasn't settled, or a stream is open." }),
    quietForMs: z.number().openapi({ description: "Milliseconds since the last event in the session. 0 while busy." }),
  })
  .openapi("Quiet");

export function createApp(options: AppOptions): App {
  const clock = options.clock ?? systemClock;
  const { log, redactor, secrets } = options;
  const ids = new IdGenerator({ seed: options.seed, clock });
  const sessions = new Sessions(ids, clock);
  const registry = new Registry();
  const events = new EventLog(clock, redactor);
  const delivery = new DeliveryQueue({ events, clock, log });

  const quiet = new QuietDetector(clock);
  events.onAppend((session) => quiet.touch(session));

  const drivers: Driver[] = DRIVERS.map((definition) =>
    definition.create({
      ids,
      clock,
      registry,
      events,
      delivery,
      log,
      expectMore: (session, what, withinMs) => quiet.expectMore(session, what, withinMs),
      arrived: (session, what) => quiet.arrived(session, what),
      secret: (name) => secrets.get(definition.name, name),
      apiUrl: () => options.urls().driver(definition.name),
      webhookUrl: options.webhooks[definition.name],
    }),
  );
  const driverNames = drivers.map((driver) => driver.name);

  sessions.onClose((session) => {
    delivery.cancel(session.id);
    for (const driver of drivers) driver.fake.release(session.id);
    registry.release(session.id);
    events.drop(session.id);
    quiet.forget(session.id);
  });

  const control = new OpenAPIHono({
    defaultHook: (result) => {
      if (!result.success) throw invalidArgument(result.error.issues);
    },
  });
  control.openAPIRegistry.registerComponent("securitySchemes", "bearer", { type: "http", scheme: "bearer" });
  control.use("*", async (c, next) => {
    await next();
    log.debug("request", { method: c.req.method, path: c.req.path, status: c.res.status });
  });
  control.use("*", requireBearer(options.token));
  control.onError((error, c) => {
    // A message or its data can quote what the caller sent, so both are scrubbed on the way out.
    if (error instanceof ProtocolError) {
      const { error: code, message, data } = error.toBody();
      return c.json({ error: code, message: redactor.text(message), data: redactor.tokens(data) }, error.status as 400);
    }
    // Hono refuses a body it can't parse before validation runs.
    if (error instanceof HTTPException && error.status === 400) {
      return c.json(new ProtocolError("invalid_argument", "The request body is not valid JSON").toBody(), 400);
    }
    // Unexpected errors can carry anything, so only a redacted line reaches the log and nothing reaches the client.
    log.error("unhandled error", { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    return c.json(new ProtocolError("internal", "Internal error").toBody(), 500);
  });

  registerRoute(control, {
    method: "get",
    path: "/status",
    summary: "Server health, version and loaded drivers",
    response: Status,
    sdkMethod: { on: "Channelstack", name: "status" },
    stability: "stable",
    handler: () => ({ ready: true, version: options.version, drivers: driverNames }),
  });

  registerRoute(control, {
    method: "post",
    path: "/sessions",
    summary: "Open a session: a scope in the shared world that owns what it creates",
    response: Session,
    factory: { on: "Channelstack", name: "openSession" },
    stability: "stable",
    handler: () => ({ sessionId: sessions.open().id, drivers: driverNames }),
  });

  registerRoute(control, {
    method: "delete",
    path: "/sessions/{session}",
    summary: "Close a session and remove everything it created",
    params: SessionParams,
    errors: ["session_not_found"],
    sdkMethod: { on: "Session", name: "close", dispose: true },
    stability: "stable",
    handler: ({ params }) => sessions.close(params.session),
  });

  registerRoute(control, {
    method: "get",
    path: "/sessions/{session}/events",
    summary: "The session's event log: actions, deliveries with every attempt, and the agent's API calls",
    params: SessionParams,
    query: z.object({
      since: z
        .string()
        .optional()
        .openapi({ param: { name: "since", in: "query" } }),
    }),
    response: EventPage,
    errors: ["session_not_found"],
    sdkMethod: { on: "Session", name: "events", options: ["since"] },
    stability: "stable",
    handler: ({ params, query }) => events.read(sessions.get(params.session).id, query.since),
  });

  registerRoute(control, {
    method: "get",
    path: "/sessions/{session}/quiet",
    summary: "Is the agent idle in this session, and for how long? Negative and exact-count matchers wait for this",
    params: SessionParams,
    response: Quiet,
    errors: ["session_not_found"],
    sdkMethod: { on: "Session", name: "quiet" },
    stability: "stable",
    handler: ({ params }) => {
      const session = sessions.get(params.session).id;
      const open = delivery.pending(session) + drivers.reduce((total, driver) => total + driver.openWork(session), 0);
      return quiet.state(session, open);
    },
  });

  registerRoute(control, {
    method: "post",
    path: "/reset",
    summary: "Drop the whole world. Avoid in parallel suites",
    sdkMethod: { on: "Channelstack", name: "reset" },
    stability: "stable",
    handler: () => {
      sessions.closeAll();
      registry.clear();
      ids.reset();
      for (const driver of drivers) driver.fake.seed();
    },
  });

  registerRoute(control, {
    method: "get",
    path: "/env",
    summary: "Env vars for the agent: fake tokens, signing secrets and API URLs (what `channelstack env` prints)",
    response: Env,
    sdkMethod: { on: "Channelstack", name: "env" },
    stability: "stable",
    handler: () => Object.assign({}, ...drivers.map((driver) => driver.env())),
  });

  for (const driver of drivers) driver.routes(new DriverRouter(control, driver.name, sessions));

  const root = new Hono();
  root.route(CONTROL_PREFIX, control);
  for (const driver of drivers) root.route(`/${driver.name}`, driver.fake.api);
  root.notFound((c) => c.json(new ProtocolError("not_found", "Nothing is served here").toBody(), 404));

  const byHost = new Map(drivers.map((driver) => [`${driver.name}.localhost`, driver]));

  return {
    fetch(request) {
      // Behind portless every driver has its own name; without it, drivers are path prefixes on one port.
      const host = (request.headers.get("x-forwarded-host") ?? new URL(request.url).host).split(":")[0] ?? "";
      const driver = byHost.get(host);
      if (driver) return quiet.during(() => driver.fake.api.fetch(request));
      // Anything outside the control API is the agent calling a fake: the agent isn't quiet while it runs.
      const fromAgent = !new URL(request.url).pathname.startsWith(CONTROL_PREFIX);
      return fromAgent ? quiet.during(() => root.fetch(request)) : root.fetch(request);
    },
    openapi: () =>
      control.getOpenAPI31Document({
        openapi: "3.1.0",
        info: { title: "channelstack control API", version: options.version },
        servers: [{ url: CONTROL_PREFIX }],
      }),
    hosts: () => ["channelstack", ...driverNames],
    settled: () => delivery.settled(),
  };
}
