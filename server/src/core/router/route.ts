import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import { type CoreErrorCode, ErrorBody, ProtocolError } from "../errors/index.ts";
import { admitLive, type DriverReality, type LiveSupport } from "../reality/index.ts";
import type { Session, Sessions } from "../sessions/index.ts";

/** How an operation shows up in the SDKs: as a method on a handle (`x-channelstack-method`) or a factory (`x-channelstack-factory`). */
interface SdkBinding {
  /** The resource the method lives on, e.g. `EchoUser`. */
  on: string;
  /** The method name, in camelCase. Emitters turn it into each language's idiom. */
  name: string;
  /** Body fields that become positional parameters, in order. */
  args?: readonly string[];
  /** Body and query fields that become the trailing options object. */
  options?: readonly string[];
  /** Path parameters bound to fields of the handle. The default binds the one parameter left to the handle's id. */
  bind?: Readonly<Record<string, string>>;
  /** This method ends the handle's life; SDKs call it on dispose. */
  dispose?: boolean;
  /**
   * A person would wait for it: SDKs repeat the call while it is refused with one of these codes
   * (a button that isn't there yet), up to the wait timeout, then report the last refusal.
   */
  retryWhile?: readonly string[];
  /** A read of what the agent has set: SDKs wait until the agent is quiet before they read. */
  onceQuiet?: boolean;
  /**
   * The first argument may also be a function the test answers with (`openai.respond(fn)`): the
   * SDK sends `flag: true` instead of the argument, and answers each call the returned handle
   * `held` (a long-poll read on it) with `answer` (a method on it), the function getting a value
   * of the `request` type.
   */
  responder?: { flag: string; held: string; answer: string; request: string };
}

/**
 * A wait built on a list read (`x-channelstack-waits`): SDKs poll the read until an item matches.
 * `next` resolves with the first new matching item since the handle last looked; `latest` waits
 * until the agent is quiet and resolves with the last matching item. `until` is for a read of
 * one value: it resolves once `field` is no longer one of `not` (`stream.ended()`).
 */
interface WaitBinding {
  name: string;
  mode: "next" | "latest" | "until";
  /** For `until`: the field to watch (the value itself without one), and the values that mean "not yet". */
  field?: string;
  not?: readonly string[];
  /** For `until`: the wait's first argument is the value, or the values, to wait for (`waitForState("complete")`). */
  in?: true;
  /**
   * For `next`: items where `field` is `value` start a new turn, and the wait looks only after the
   * newest of them. A person's prompt in an agent session is one: what the agent says next answers it.
   */
  turn?: { field: string; value: string };
  /** The item field holding who authored it; the wait's `from` option filters on it. */
  from?: string;
  /** A text field of the item the wait can be narrowed by: an option of that name takes a string or a pattern. */
  text?: string;
  /** The wait takes the read's own options as its first argument: `waitForCall({ operation }, { timeout })`. */
  filter?: true;
  /** For `next` and `latest`: only items whose fields have these values count (a modal that is still `open`). */
  where?: Readonly<Record<string, string | number | boolean>>;
  /** What is being waited for, for the timeout message: "a reply". */
  what: string;
}

type AnyObject = z.ZodObject<z.ZodRawShape>;

interface RouteBase<P extends AnyObject, Q extends AnyObject, B extends z.ZodType, R extends z.ZodType> {
  method: "get" | "post" | "delete";
  /** Path with `{param}` placeholders. */
  path: string;
  summary: string;
  params?: P;
  query?: Q;
  body?: B;
  /** The 200 response. Leave it out for 204. */
  response?: R;
  /** Error codes this operation can return, beyond the ones every route can return: the protocol's own, or a platform's. */
  errors?: readonly string[];
  factory?: SdkBinding;
  sdkMethod?: SdkBinding;
  /** Waits SDKs build on this list read. */
  waits?: readonly WaitBinding[];
  stability: "experimental" | "stable";
  /**
   * How the operation works on a live driver (reality-matrix.md). Left out, it works live. A route
   * that doesn't is refused there before its handler runs: `unsupported_in_live` or `action_requires`.
   */
  live?: LiveSupport;
}

interface Input<P extends AnyObject, Q extends AnyObject, B extends z.ZodType> {
  params: z.infer<P>;
  query: z.infer<Q>;
  body: z.infer<B>;
}

type Result<R extends z.ZodType> = [R] extends [z.ZodUndefined]
  ? void | Promise<void>
  : z.input<R> | Promise<z.input<R>>;

export interface RouteSpec<
  P extends AnyObject,
  Q extends AnyObject,
  B extends z.ZodType,
  R extends z.ZodType,
> extends RouteBase<P, Q, B, R> {
  handler(input: Input<P, Q, B>): Result<R>;
}

export interface DriverRouteSpec<
  P extends AnyObject,
  Q extends AnyObject,
  B extends z.ZodType,
  R extends z.ZodType,
> extends RouteBase<P, Q, B, R> {
  handler(input: Input<P, Q, B> & { session: Session }): Result<R>;
}

const ALWAYS: readonly CoreErrorCode[] = ["unauthorized", "invalid_argument", "internal"];

/**
 * Register one control API route: validation, the OpenAPI operation and its `x-channelstack-*`
 * extensions come from the same spec, so the SDKs can't drift from what the server accepts.
 */
export function registerRoute<
  P extends AnyObject = AnyObject,
  Q extends AnyObject = AnyObject,
  B extends z.ZodType = z.ZodUndefined,
  R extends z.ZodType = z.ZodUndefined,
>(app: OpenAPIHono, spec: RouteSpec<P, Q, B, R>): void {
  // A response that may be null keeps that in the OpenAPI document: as a top-level `nullable()`
  // of a named schema it would be written as the bare reference, and SDKs would decode a null.
  const response =
    spec.response instanceof z.ZodNullable ? z.union([spec.response.unwrap() as z.ZodType, z.null()]) : spec.response;
  const route = createRoute({
    method: spec.method,
    path: spec.path,
    summary: spec.summary,
    security: [{ bearer: [] }],
    request: {
      ...(spec.params ? { params: spec.params } : {}),
      ...(spec.query ? { query: spec.query } : {}),
      ...(spec.body ? { body: { required: true, content: { "application/json": { schema: spec.body } } } } : {}),
    },
    responses: {
      ...(response
        ? { 200: { description: "OK", content: { "application/json": { schema: response } } } }
        : { 204: { description: "Done" } }),
      default: { description: "A protocol error", content: { "application/json": { schema: ErrorBody } } },
    },
    ...(spec.factory ? { "x-channelstack-factory": spec.factory } : {}),
    ...(spec.sdkMethod ? { "x-channelstack-method": spec.sdkMethod } : {}),
    ...(spec.waits ? { "x-channelstack-waits": spec.waits } : {}),
    "x-channelstack-error-codes": [...new Set([...ALWAYS, ...(spec.errors ?? [])])],
    "x-channelstack-stability": spec.stability,
    ...(spec.live ? { "x-channelstack-live": spec.live } : {}),
  });

  // The handler's types come from the spec's schemas above; Hono's own inference isn't needed on top.
  app.openapi(
    route as never,
    (async (c: {
      req: { valid(target: string): unknown };
      json(body: unknown, status: number): Response;
      body(body: null, status: number): Response;
    }) => {
      const result = await spec.handler({
        params: (spec.params ? c.req.valid("param") : {}) as z.infer<P>,
        query: (spec.query ? c.req.valid("query") : {}) as z.infer<Q>,
        body: (spec.body ? c.req.valid("json") : undefined) as z.infer<B>,
      });
      // Parsing the result strips anything the schema doesn't declare, so a store record never leaks through a route.
      return spec.response ? c.json(spec.response.parse(result), 200) : c.body(null, 204);
    }) as never,
  );
}

export const SessionParams = z.object({
  session: z.string().openapi({ param: { name: "session", in: "path" }, example: "ses_k3f9a1b2c3d4e5f6g7h8" }),
});

/** What every driver route can be refused with live, besides its own errors. */
const LIVE_ERRORS = [
  "unsupported_in_live",
  "action_requires",
  "live_misconfigured",
  "live_not_allowlisted",
  "fake_actor_in_live_world",
  "cross_workspace_credential",
] as const;

/**
 * Registers a driver's routes under `/sessions/{session}/<driver>`, resolves the session for each
 * call, and on a live driver lets through only what works live (core decides, not the driver).
 */
export class DriverRouter {
  readonly #app: OpenAPIHono;
  readonly #driver: string;
  readonly #sessions: Sessions;
  readonly #reality: (() => DriverReality) | undefined;

  /** The driver whose routes these are (`notion`). */
  get driver(): string {
    return this.#driver;
  }

  /** `reality` is for a driver that can be live: its routes then also list what live refuses with. */
  constructor(app: OpenAPIHono, driver: string, sessions: Sessions, reality?: () => DriverReality) {
    this.#app = app;
    this.#driver = driver;
    this.#sessions = sessions;
    this.#reality = reality;
  }

  route<
    P extends AnyObject = typeof SessionParams,
    Q extends AnyObject = AnyObject,
    B extends z.ZodType = z.ZodUndefined,
    R extends z.ZodType = z.ZodUndefined,
  >(spec: DriverRouteSpec<P, Q, B, R>): void {
    const params = (spec.params ? SessionParams.extend(spec.params.shape) : SessionParams) as unknown as P;
    registerRoute<P, Q, B, R>(this.#app, {
      ...spec,
      path: `/sessions/{session}/${this.#driver}${spec.path}`,
      params,
      errors: ["session_not_found", ...(this.#reality ? LIVE_ERRORS : []), ...(spec.errors ?? [])],
      handler: (async (input: Input<P, Q, B>) => {
        const session = this.#sessions.get((input.params as { session: string }).session);
        const binding = spec.sdkMethod ?? spec.factory;
        const operation = binding ? `${binding.on}.${binding.name}` : `${spec.method.toUpperCase()} ${spec.path}`;
        if (this.#reality) await admitLive(this.#reality(), operation, spec.live, this.#driver);
        return spec.handler({ ...input, session });
      }) as RouteSpec<P, Q, B, R>["handler"],
    });
  }
}

/** A request that failed validation becomes the protocol's `invalid_argument`. */
export function invalidArgument(issues: readonly { path: PropertyKey[]; message: string }[]): ProtocolError {
  const first = issues[0];
  const where = first && first.path.length > 0 ? `${first.path.map(String).join(".")}: ` : "";
  return new ProtocolError("invalid_argument", `${where}${first?.message ?? "Invalid request"}`, {
    issues: issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
  });
}
