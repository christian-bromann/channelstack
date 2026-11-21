import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type CoreErrorCode, ErrorBody, ProtocolError } from "../errors/index.ts";
import type { Session, Sessions } from "../sessions/index.ts";

/** How an operation shows up in the SDKs: as a method on a handle (`x-channelstack-method`) or a factory (`x-channelstack-factory`). */
export interface SdkBinding {
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
  stability: "experimental" | "stable";
}

interface Input<P extends AnyObject, Q extends AnyObject, B extends z.ZodType> {
  params: z.infer<P>;
  query: z.infer<Q>;
  body: z.infer<B>;
}

type Result<R extends z.ZodType> = [R] extends [z.ZodUndefined]
  ? void | Promise<void>
  : z.input<R> | Promise<z.input<R>>;

export interface RouteSpec<P extends AnyObject, Q extends AnyObject, B extends z.ZodType, R extends z.ZodType>
  extends RouteBase<P, Q, B, R> {
  handler(input: Input<P, Q, B>): Result<R>;
}

export interface DriverRouteSpec<P extends AnyObject, Q extends AnyObject, B extends z.ZodType, R extends z.ZodType>
  extends RouteBase<P, Q, B, R> {
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
      ...(spec.response
        ? { 200: { description: "OK", content: { "application/json": { schema: spec.response } } } }
        : { 204: { description: "Done" } }),
      default: { description: "A protocol error", content: { "application/json": { schema: ErrorBody } } },
    },
    ...(spec.factory ? { "x-channelstack-factory": spec.factory } : {}),
    ...(spec.sdkMethod ? { "x-channelstack-method": spec.sdkMethod } : {}),
    "x-channelstack-error-codes": [...new Set([...ALWAYS, ...(spec.errors ?? [])])],
    "x-channelstack-stability": spec.stability,
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

/** Registers a driver's routes under `/sessions/{session}/<driver>` and resolves the session for each call. */
export class DriverRouter {
  readonly #app: OpenAPIHono;
  readonly #driver: string;
  readonly #sessions: Sessions;

  constructor(app: OpenAPIHono, driver: string, sessions: Sessions) {
    this.#app = app;
    this.#driver = driver;
    this.#sessions = sessions;
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
      errors: ["session_not_found", ...(spec.errors ?? [])],
      handler: (input) => {
        const session = this.#sessions.get((input.params as { session: string }).session);
        return spec.handler({ ...input, session });
      },
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
