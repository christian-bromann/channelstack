import { OpenAPIHono, z } from "@hono/zod-openapi";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";

import { type Attribution, Attributor, bodyStrings, type KnownString, stringsOf } from "./core/attribution/index.ts";
import { requireAccess } from "./core/auth/index.ts";
import { UI_COOKIE, UiAccess } from "./core/auth/ui.ts";
import { BrowserActors, type Launch } from "./core/browser/index.ts";
import { type Clock, systemClock, systemTimers, type Timers } from "./core/clock/index.ts";
import { DeliveryQueue } from "./core/delivery/index.ts";
import type { DevApi } from "./core/dev/index.ts";
import { registerPlaceRoutes } from "./core/dev/routes.ts";
import { CORE_ERRORS, ProtocolError } from "./core/errors/index.ts";
import { EventLog, WORLD_SCOPE } from "./core/events/index.ts";
import { IdGenerator } from "./core/ids/index.ts";
import { Ledger } from "./core/ledger/index.ts";
import type { Logger } from "./core/log/index.ts";
import { nodeOptions } from "./core/proxy/node.ts";
import type { Recorder } from "./core/proxy/record.ts";
import { QuietDetector } from "./core/quiet/index.ts";
import {
  actionRequires,
  type DriverReality,
  driverReality,
  forcedReality,
  unsupportedInLive,
} from "./core/reality/index.ts";
import type { Redactor } from "./core/redact/index.ts";
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
import { channelsExtension, DEV_CHANNELS, DRIVERS, secretSpecs } from "./drivers/index.ts";

export const CONTROL_PREFIX = "/_channelstack";

/** Where the server is reachable: decided by portless or `--no-portless`, and known only once it listens. */
export interface ServerUrls {
  /** UI and control API base, e.g. `https://channelstack.localhost`. */
  control: string;
  /**
   * A driver's fake provider API, e.g. `https://echo.localhost` or `http://127.0.0.1:4500/echo`.
   * In proxy mode, the provider's own origin (`https://slack.com`), which the proxy routes to it.
   */
  driver(name: string): string;
  /** Proxy mode: where the proxy listens and the files the agent trusts channelstack's CA from. */
  proxy?: ProxyEnv;
}

/** What an agent needs for proxy mode (implementation plan 6.2). */
interface ProxyEnv {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  /** channelstack's CA alone, for `NODE_EXTRA_CA_CERTS`. */
  caFile: string;
  /** The public roots and the CA, for runtimes that replace their bundle (`SSL_CERT_FILE`). */
  bundleFile: string;
  /** The preload that keeps Node's proxy-aware `fetch` in an agent that loads undici (`writeNodePreload`). */
  nodePreload: string;
}

/** The environment that points an agent at the proxy and trusts channelstack's CA in it, and only there. */
function proxyEnv(proxy: ProxyEnv): Record<string, string> {
  // Loopback and *.localhost stay direct: the agent's own server, and anything portless serves.
  const direct = "localhost,127.0.0.1,::1,.localhost";
  return {
    HTTPS_PROXY: proxy.url,
    HTTP_PROXY: proxy.url,
    https_proxy: proxy.url,
    http_proxy: proxy.url,
    NO_PROXY: direct,
    no_proxy: direct,
    // Node 24 routes its own http, https and fetch through the proxy only with this.
    NODE_USE_ENV_PROXY: "1",
    NODE_OPTIONS: nodeOptions(proxy.nodePreload),
    NODE_EXTRA_CA_CERTS: proxy.caFile,
    SSL_CERT_FILE: proxy.bundleFile,
    REQUESTS_CA_BUNDLE: proxy.bundleFile,
  };
}

/** The names `env --proxy` adds, for whatever takes only those from what it prints. */
export const PROXY_ENV_NAMES: readonly string[] = Object.keys(
  proxyEnv({ url: "", caFile: "", bundleFile: "", nodePreload: "" }),
);

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
  /** Proxy mode's `--record`: the shape of every webhook a fake delivers (and, in `serve.ts`, every exchange). */
  recorder?: Recorder;
}

export interface LiveOptions {
  /** Where credentials, allowlists, `CHANNELSTACK_REALITY` and `CHANNELSTACK_RUN_ID` come from: the server's environment. */
  env: Readonly<Record<string, string | undefined>>;
  /** The ledger file this server writes; without it the ledger stays in memory. */
  ledgerFile?: string;
  /** The state directory: where people's saved browser sessions are. */
  home?: string;
  /** For unit tests: a stand-in for the browser actor's Chrome. */
  launchBrowser?: Launch;
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
  /** Whether this driver runs live: in proxy mode, its agent's calls go on to the platform. */
  live(driver: string): boolean;
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
    problems: z.array(z.string()).openapi({
      description:
        "What should fail the test at once, in words: a model call no script answered. Waiting matchers fail on these instead of timing out.",
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
  const { recorder } = options;
  const delivery = new DeliveryQueue({
    events,
    clock,
    timers,
    log,
    ...(recorder ? { observe: (request) => recorder.webhook(request.driver, request.type, request.body) } : {}),
  });

  const quiet = new QuietDetector(clock);
  events.onAppend((session) => quiet.touch(session));

  const liveEnv = options.live?.env ?? {};
  // Not from the seeded ids: two runs with the same seed must still tag their objects apart.
  const run = runId(liveEnv);
  // Unique per server too: a re-run of a CI job keeps its run id.
  const ledger = new Ledger({
    file: options.live?.ledgerFile,
    run,
    server: randomString(6, "abcdefghijklmnopqrstuvwxyz0123456789"),
    clock,
    log,
  });
  const vault = new LiveVault(liveEnv, (secret) => redactor.register(secret));
  const browsers = new BrowserActors(options.live?.launchBrowser);

  // What each session's agent was told: its deliveries' bodies and its API calls' answers. A
  // provider's request names no session; attribution finds it in these (decision 0029).
  const knownCache = new Map<string, { at: number; strings: KnownString[] }>();
  const attribution = new Attributor({
    sessions: () => sessions.ids(),
    known: (session) => {
      const strings: KnownString[] = [];
      for (const record of delivery.list(session)) {
        const sent = record.attempts[0]?.sentAt;
        const at = sent === undefined ? clock() : Date.parse(sent);
        let cached = knownCache.get(record.request.id);
        if (!cached) {
          cached = {
            at,
            strings: bodyStrings(record.request.body).map((text) => ({
              text,
              driver: record.request.driver,
              delivery: record.request.id,
              at,
            })),
          };
          knownCache.set(record.request.id, cached);
        }
        strings.push(...cached.strings);
      }
      for (const event of events.read(session).events) {
        if (event.kind !== "api_call" || DRIVERS.find((definition) => definition.name === event.driver)?.provider)
          continue;
        const at = Date.parse(event.at);
        for (const text of stringsOf(event.data.response)) strings.push({ text, driver: event.driver, at });
      }
      return strings;
    },
  });
  sessions.onClose((session) => {
    for (const record of delivery.list(session.id)) knownCache.delete(record.request.id);
  });
  /** Where an attributed call is in the channels: the delivery that decided it, as its driver reads it. */
  const place = (attributed: Attribution | undefined) => {
    const source = attributed?.source;
    if (!attributed || !source) return {};
    const definition = DRIVERS.find((candidate) => candidate.name === source.driver);
    const records = delivery.list(attributed.session);
    // A tag that is a person's id: the newest message that person wrote, not any delivery naming them.
    const byAuthor =
      attributed.by === "tag" && attributed.matched !== undefined
        ? records
            .toReversed()
            .map((record) => ({ record, at: DRIVERS.find((candidate) => candidate.name === record.request.driver) }))
            .map(({ record, at }) => ({ driver: record.request.driver, found: at?.place?.(record.request.body) }))
            .find(({ found }) => found?.from === attributed.matched)
        : undefined;
    if (byAuthor?.found) return { channel: byAuthor.driver, ...byAuthor.found };
    const record =
      source.delivery === undefined ? undefined : records.find((candidate) => candidate.request.id === source.delivery);
    const found = record ? definition?.place?.(record.request.body) : undefined;
    return { channel: source.driver, ...(found ?? {}) };
  };

  /** Which secrets channelstack knows are in a text, by kind: fake ones by name, tokens by shape, the control token, live credentials. */
  const findSecrets = (text: string): string[] => {
    const kinds: string[] = [];
    for (const [driver, spec] of Object.entries(secretSpecs())) {
      for (const name of Object.keys(spec)) {
        const value = secrets.get(driver, name);
        if (value.length >= 8 && text.includes(value)) kinds.push(`${driver}.${name}`);
      }
    }
    for (const definition of DRIVERS) {
      const shaped = definition.tokenPatterns.some((pattern) =>
        new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(text),
      );
      if (shaped && !kinds.some((kind) => kind.startsWith(`${definition.name}.`)))
        kinds.push(`a ${definition.title} token`);
    }
    if (text.includes(options.token)) kinds.push("the control API's token");
    // Anything else the redactor knows: a live credential, registered when it was handed over.
    if (kinds.length === 0 && JSON.stringify(redactor.tokens(text)) !== JSON.stringify(text))
      kinds.push("a live credential");
    return kinds;
  };

  /** Whether a URL is on one of the fakes' addresses: its `*.localhost` name, or its path prefix without portless. */
  const onFake = (url: string): boolean => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    return DRIVERS.some((definition) => {
      const base = options.urls().driver(definition.name);
      // The parsed URL, as `fetch` will send it: never the text, which a fake's prefix could hide inside.
      const { href } = parsed;
      return parsed.hostname === `${definition.name}.localhost` || href === base || href.startsWith(`${base}/`);
    });
  };
  /** The app as it serves requests, once it is built: what `fetchFake` sends a URL on a fake's address to. */
  const served: { fetch(request: Request): Response | Promise<Response> } = {
    fetch: () => new Response(null, { status: 503 }),
  };

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
      attribution,
      place,
      findSecrets,
      fetchFake: (url) => (onFake(url) ? Promise.resolve(served.fetch(new Request(url))) : undefined),
      scrub: (value) => redactor.tokens(value),
      live: {
        active: driverReality(liveEnv, definition.live?.credentials ?? [], undefined).mode === "live",
        strict: forcedReality(liveEnv) === "live",
        vault,
        allowlist: new Allowlist(definition.live?.allowlist ?? "", liveEnv),
        ledger,
        tag: runTag(run),
        fetch: options.live?.fetch ?? fetch,
        browsers,
        home: options.live?.home,
        apiBase: options.live?.apiBase?.[definition.name],
      },
    }),
  );
  const driverNames = drivers.map((driver) => driver.name);
  const providers = new Set(drivers.filter((_, at) => DRIVERS[at]?.provider));
  const realities = new Map<string, DriverReality>(
    drivers.map((driver, at) => [
      driver.name,
      driverReality(liveEnv, DRIVERS[at]?.live?.credentials ?? [], driver.live),
    ]),
  );

  // A session's browsers close first; then what it created comes off the real platform, while its records still exist.
  sessions.onClose((session) => browsers.close(session.id));
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
      return c.json({ error: code, message: redactor.text(message), data: redactor.data(data) }, error.status as 400);
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
      const problems = drivers.flatMap((driver) => driver.problems?.(session) ?? []);
      return { ...quiet.state(session, open.length), open, problems };
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
    summary:
      "Env vars for the agent: fake tokens, signing secrets and API URLs (what `channelstack env` prints). With `proxy`, the proxy and the CA instead of the API URLs",
    query: z.object({
      proxy: z
        .stringbool()
        .optional()
        // On the wire `true` or `false`; to the SDKs a boolean.
        .openapi({
          type: "boolean",
          param: { name: "proxy", in: "query" },
          description: "For proxy mode: `channelstack env --proxy`",
        }),
    }),
    response: Env,
    errors: ["action_requires"],
    sdkMethod: { on: "Channelstack", name: "env", options: ["proxy"] },
    stability: "stable",
    handler: ({ query }) => {
      // A live channel prints nothing: the agent talks to the platform with its own configuration, and
      // live credentials never leave the server.
      const fake = drivers.filter((driver) => realities.get(driver.name)?.mode !== "live");
      const env: Record<string, string> = Object.assign({}, ...fake.map((driver) => driver.env()));
      if (query.proxy !== true) return env;
      const proxy = options.urls().proxy;
      if (!proxy) {
        throw new ProtocolError(
          "action_requires",
          "channelstack env --proxy needs proxy mode: start the server with --proxy",
          { operation: "Channelstack.env", requires: "proxy mode" },
        );
      }
      // An agent in proxy mode keeps its own API URLs: the proxy sends the provider's hosts to the fakes.
      const origins = DRIVERS.flatMap((definition) => (definition.hosts ?? []).map((host) => `https://${host}`));
      const urls = (value: string) => origins.some((origin) => value === origin || value.startsWith(`${origin}/`));
      return { ...Object.fromEntries(Object.entries(env).filter(([, value]) => !urls(value))), ...proxyEnv(proxy) };
    },
  });

  DRIVERS.forEach((definition, at) => {
    const driver = drivers[at] as Driver;
    const reality = realities.get(driver.name) ?? { mode: "fake" as const };
    driver.routes(new DriverRouter(control, driver.name, sessions, definition.live ? () => reality : undefined));
  });

  // Every channel's places as the dev tools name them, for the UI: each channel's control API,
  // called in process with the server's own token.
  registerPlaceRoutes(control, {
    sessions,
    channels: DEV_CHANNELS,
    api: (session, channel): DevApi => {
      const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        const response = await control.request(`/sessions/${encodeURIComponent(session)}/${channel}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${options.token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = (await response.json()) as T & { error?: string; message?: string };
        if (!response.ok) {
          throw new ProtocolError({ platform: data.error ?? "internal", status: response.status }, data.message ?? "");
        }
        return data;
      };
      return { get: (path) => call("GET", path), post: (path, body) => call("POST", path, body) };
    },
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
  /** The fakes whose SDKs call paths at the server's root (`googleapis`), by those paths. */
  const rooted = drivers.flatMap((driver, at) => (DRIVERS[at]?.rootPaths ?? []).map((path) => ({ path, driver })));
  root.notFound((c) => c.json(new ProtocolError("not_found", "Nothing is served here").toBody(), 404));

  // A driver's own name, and in proxy mode the provider's hosts, which arrive through the proxy's TLS listener.
  const byHost = new Map(
    drivers.flatMap((driver, at) => [
      [`${driver.name}.localhost`, driver] as const,
      ...(DRIVERS[at]?.hosts ?? []).map((host) => [host, driver] as const),
    ]),
  );

  const app: App = {
    fetch(request) {
      // Behind portless every driver has its own name; without it, drivers are path prefixes on one port.
      const host = (request.headers.get("x-forwarded-host") ?? new URL(request.url).host).split(":")[0] ?? "";
      const driver =
        byHost.get(host) ?? rooted.find(({ path }) => new URL(request.url).pathname.startsWith(path))?.driver;
      // A provider's call is in flight for its session alone (its open work), not for every session.
      if (driver)
        return providers.has(driver)
          ? driver.fake.api.fetch(request)
          : quiet.during(() => driver.fake.api.fetch(request));
      // Anything outside the control API is the agent calling a fake: the agent isn't quiet while it runs.
      const { pathname } = new URL(request.url);
      const fromAgent =
        !pathname.startsWith(CONTROL_PREFIX) &&
        ![...providers].some((provider) => pathname.startsWith(`/${provider.name}/`));
      return fromAgent ? quiet.during(() => root.fetch(request)) : root.fetch(request);
    },
    openapi: () => ({
      ...control.getOpenAPI31Document({
        openapi: "3.1.0",
        info: { title: "channelstack control API", version: options.version },
        servers: [{ url: CONTROL_PREFIX }],
      }),
      // What channelstack's own error codes mean; a fake's codes are the platform's.
      "x-channelstack-errors": CORE_ERRORS,
      // The drivers in the binary, so generators and scripts don't keep their own list.
      "x-channelstack-channels": channelsExtension(),
    }),
    hosts: () => ["channelstack", ...driverNames],
    settled: () => delivery.settled(),
    close: () => sessions.closeAll(),
    live: (driver) => realities.get(driver)?.mode === "live",
    uiLoginLink,
    socket(request) {
      // The same routing as for requests: a driver's own host, or its path prefix.
      const { host, pathname } = new URL(request.url);
      const named = (request.headers.get("x-forwarded-host") ?? host).split(":")[0] ?? "";
      const driver = byHost.get(named) ?? drivers.find((candidate) => pathname.startsWith(`/${candidate.name}/`));
      return driver?.fake.socket?.(request);
    },
  };
  served.fetch = (request) => app.fetch(request);
  return app;
}
