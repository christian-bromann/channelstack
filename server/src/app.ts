import { OpenAPIHono, z } from "@hono/zod-openapi";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";

import { requireAccess } from "./core/auth/index.ts";
import { UI_COOKIE, UiAccess } from "./core/auth/ui.ts";
import { type Clock, systemClock, systemTimers, type Timers } from "./core/clock/index.ts";
import { DeliveryQueue } from "./core/delivery/index.ts";
import { ProtocolError } from "./core/errors/index.ts";
import { EventLog, WORLD_SCOPE } from "./core/events/index.ts";
import { IdGenerator } from "./core/ids/index.ts";
import { Ledger } from "./core/ledger/index.ts";
import type { Logger } from "./core/log/index.ts";
import { QuietDetector } from "./core/quiet/index.ts";
import type { Redactor } from "./core/redact/index.ts";
import {
  actionRequires,
  type DriverReality,
  driverReality,
  forcedReality,
  unsupportedInLive,
} from "./core/reality/index.ts";
import { Registry } from "./core/registry/index.ts";
import {
  type Driver,
  DriverRouter,
  invalidArgument,
  registerRoute,
  SessionParams,
  type SocketSession,
} from "./core/router/index.ts";
import { Allowlist, runId, runTag } from "./core/safety/index.ts";
import { LiveVault, randomString, randomToken, type Secrets } from "./core/secrets/index.ts";
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
  /**
   * The UI: one HTML page. `__NONCE__` in it becomes the response's CSP nonce and `__SESSION__`
   * the id of the shared `dev` session. Without it the server has no UI.
   */
  ui?: string;
  clock?: Clock;
  /** How things happen later (a platform's retry). Tests pass timers they move themselves. */
  timers?: Timers;
  /** Live mode: what makes drivers real (live-mode.md). Without it every driver is fake. */
  live?: LiveOptions;
}

export interface LiveOptions {
  /** Where credentials, allowlists, `CHANNELSTACK_REALITY` and `CHANNELSTACK_RUN_ID` come from: the server's environment. */
  env: Readonly<Record<string, string | undefined>>;
  /** The ledger file this server writes; without it the ledger stays in memory. */
  ledgerFile?: string;
  /** For unit tests: how the live backends reach their platforms, and the platforms' base URLs by driver. */
  fetch?: typeof fetch;
  apiBase?: Readonly<Record<string, string>>;
}

export interface App {
  fetch(request: Request): Response | Promise<Response>;
  /** The control API as an OpenAPI 3.1 document, with the `x-channelstack-*` extensions the SDK generator reads. */
  openapi(): object;
  /** `<name>.localhost` for the control API and every driver. */
  hosts(): string[];
  /** Resolves once no delivery is in flight. */
  settled(): Promise<void>;
  /** A new one-time link that opens the UI in a browser. */
  uiLoginLink(): string;
  /** A WebSocket the agent wants to open to a fake: what handles it, or nothing when no fake expects one there. */
  socket(request: Request): SocketSession | undefined;
  /** Close every session: what live sessions created is removed from the real platforms. */
  close(): Promise<void>;
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
    summary: z.object({ text: z.string(), outcome: z.string(), ok: z.boolean() }).optional().openapi({
      description: "Delivery attempts and API calls in one line, e.g. `← slack chat.postMessage` and `200`.",
    }),
  })
  .openapi("LogEvent");

const EventPage = z.object({ events: z.array(LogEvent), cursor: z.string() }).openapi("EventPage");

const Env = z.record(z.string(), z.string()).openapi("Env");

const Quiet = z
  .object({
    busy: z.boolean().openapi({
      description:
        "A call from the agent is in flight, a delivery is in flight or about to be retried, or a stream is open.",
    }),
    quietForMs: z.number().openapi({ description: "Milliseconds since the last event in the session. 0 while busy." }),
    open: z.array(z.string()).openapi({
      description: "What is still open, in words: deliveries in flight or about to be retried, streams never stopped.",
    }),
  })
  .openapi("Quiet");

export function createApp(options: AppOptions): App {
  const clock = options.clock ?? systemClock;
  const { log, redactor, secrets } = options;
  const ids = new IdGenerator({ seed: options.seed, clock });
  const sessions = new Sessions(ids, clock);
  const registry = new Registry();
  const events = new EventLog(clock, redactor);
  const timers = options.timers ?? systemTimers;
  const delivery = new DeliveryQueue({ events, clock, timers, log });

  const quiet = new QuietDetector(clock);
  events.onAppend((session) => quiet.touch(session));

  const liveEnv = options.live?.env ?? {};
  // Not from the seeded ids: two runs with the same seed must still tag their objects apart.
  const run = runId(liveEnv, () => randomString(10, "abcdefghijklmnopqrstuvwxyz0123456789"));
  const ledger = new Ledger({ file: options.live?.ledgerFile, run, clock, log });
  const vault = new LiveVault(liveEnv, (secret) => redactor.register(secret));

  const drivers: Driver[] = DRIVERS.map((definition) =>
    definition.create({
      ids,
      clock,
      timers,
      registry,
      events,
      delivery,
      log,
      expectMore: (session, what, withinMs) => quiet.expectMore(session, what, withinMs),
      arrived: (session, what) => quiet.arrived(session, what),
      secret: (name) => secrets.get(definition.name, name),
      apiUrl: () => options.urls().driver(definition.name),
      webhookUrl: options.webhooks[definition.name],
      live: {
        active: driverReality(liveEnv, definition.live?.credentials ?? [], undefined).mode === "live",
        strict: forcedReality(liveEnv) === "live",
        vault,
        allowlist: new Allowlist(definition.live?.allowlist ?? "", liveEnv),
        ledger,
        tag: runTag(run),
        fetch: options.live?.fetch ?? fetch,
        apiBase: options.live?.apiBase?.[definition.name],
      },
    }),
  );
  const driverNames = drivers.map((driver) => driver.name);
  const realities = new Map<string, DriverReality>(
    drivers.map((driver, at) => [driver.name, driverReality(liveEnv, DRIVERS[at]?.live?.credentials ?? [], driver.live)]),
  );

  // What a live session created comes off the real platform first, while its records still exist.
  sessions.onClose((session) => ledger.cleanup(session.id).then(() => undefined));
  sessions.onClose((session) => {
    delivery.cancel(session.id);
    for (const driver of drivers) {
      driver.fake.release(session.id);
      driver.live?.release(session.id);
    }
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
  const ui = new UiAccess((secret) => redactor.register(secret));
  control.use(
    "*",
    requireAccess({ token: options.token, ui, prefix: CONTROL_PREFIX, scrub: (body) => redactor.tokens(body) }),
  );
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
    body: z
      .object({
        name: z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,31}$/)
          .optional()
          .openapi({ description: "Share the session: the open session of this name is returned if there is one." }),
      })
      .optional(),
    response: Session,
    factory: { on: "Channelstack", name: "openSession", options: ["name"] },
    stability: "stable",
    handler: ({ body }) => ({ sessionId: sessions.open(body?.name).id, drivers: driverNames }),
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
    errors: ["session_not_found", "action_requires"],
    sdkMethod: { on: "Session", name: "quiet" },
    stability: "stable",
    handler: ({ params }) => {
      const session = sessions.get(params.session).id;
      // Live, the agent works on the real platform: nothing tells channelstack when it is done.
      if (ledger.entries(session).length > 0) {
        throw actionRequires(
          "Session.quiet",
          "proxy mode",
          "this session acted live, and without proxy mode channelstack can't see when the agent is done",
        );
      }
      const pending = delivery.pending(session);
      const deliveries = `${pending} ${pending === 1 ? "delivery" : "deliveries"} in flight or about to be retried`;
      const open = [...(pending > 0 ? [deliveries] : []), ...drivers.flatMap((driver) => driver.openWork(session))];
      return { ...quiet.state(session, open.length), open };
    },
  });

  registerRoute(control, {
    method: "post",
    path: "/reset",
    summary: "Drop the whole world. Avoid in parallel suites",
    sdkMethod: { on: "Channelstack", name: "reset" },
    errors: ["unsupported_in_live"],
    stability: "stable",
    handler: async () => {
      const live = [...realities].filter(([, reality]) => reality.mode === "live").map(([name]) => name);
      if (live.length > 0) {
        throw unsupportedInLive(
          "Channelstack.reset",
          `${live.join(", ")} ${live.length === 1 ? "is" : "are"} live, and a real workspace is never wiped: each session removes what it made, and channelstack sweep removes leftovers`,
        );
      }
      await sessions.closeAll();
      events.drop(WORLD_SCOPE);
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

  DRIVERS.forEach((definition, at) => {
    const driver = drivers[at] as Driver;
    const reality = realities.get(driver.name) ?? { mode: "fake" as const };
    driver.routes(new DriverRouter(control, driver.name, sessions, definition.live ? () => reality : undefined));
  });

  const uiLoginLink = () => `${options.urls().control}/?login=${ui.issueCode()}`;
  registerRoute(control, {
    method: "post",
    path: "/ui/login-links",
    summary: "A new one-time link that opens the UI in a browser (what `channelstack ui` prints)",
    response: z.object({ url: z.string() }).openapi("UiLoginLink"),
    sdkMethod: { on: "Channelstack", name: "uiLoginLink" },
    stability: "experimental",
    handler: () => ({ url: uiLoginLink() }),
  });

  const root = new Hono();
  root.route(CONTROL_PREFIX, control);
  root.get("/", (c) => {
    // A login link trades its one-time code for a session cookie, then sends the browser to the plain address.
    const code = c.req.query("login");
    const granted = code === undefined ? undefined : ui.redeem(code);
    if (granted !== undefined) {
      setCookie(c, UI_COOKIE, granted, {
        httpOnly: true,
        sameSite: "Strict",
        path: "/",
        secure: options.urls().control.startsWith("https:"),
      });
      return c.redirect("/", 302);
    }
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
    if (options.ui === undefined || !ui.knows(getCookie(c, UI_COOKIE))) {
      return c.text("Open the UI with a login link: `channelstack ui` prints one.\n", 401);
    }
    // The page's own script and style run; nothing else does, whatever an agent writes into a message.
    const nonce = randomToken(16);
    c.header(
      "content-security-policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    return c.html(options.ui.replaceAll("__NONCE__", nonce).replaceAll("__SESSION__", sessions.open("dev").id));
  });
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
    close: () => sessions.closeAll(),
    uiLoginLink,
    socket(request) {
      // The same routing as for requests: a driver's own host, or its path prefix.
      const { host, pathname } = new URL(request.url);
      const named = (request.headers.get("x-forwarded-host") ?? host).split(":")[0] ?? "";
      const driver = byHost.get(named) ?? drivers.find((candidate) => pathname.startsWith(`/${candidate.name}/`));
      return driver?.fake.socket?.(request);
    },
  };
}
