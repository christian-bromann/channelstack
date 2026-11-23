import { Hono } from "hono";

import { bearerFrom } from "../../../core/auth/index.ts";
import type { DriverContext } from "../../../core/router/index.ts";
import { recordCall } from "../../../core/router/inspect.ts";
import { constantTimeEqual } from "../../../core/signing/hmac.ts";
import { type GraphQLRequest, rootFields, runGraphQL } from "./graphql.ts";
import type { LinearCallContext } from "./models.ts";
import { linearResolvers } from "./resolvers.ts";
import type { FakeLinearWorld } from "./world.ts";

const authError = (message: string) => ({
  errors: [
    {
      message,
      extensions: {
        type: "authentication error",
        code: "AUTHENTICATION_ERROR",
        statusCode: 401,
        userError: true,
        userPresentableMessage: message,
      },
    },
  ],
});

/**
 * Linear's GraphQL API, as the agent's app sees it: `POST /graphql` with the app's OAuth token. Each
 * call is on record for the test sessions whose objects it read or changed, by the root field it
 * asked for (`agentActivityCreate`); calls about nothing a session owns, for no session.
 */
export function createLinearApi(context: DriverContext, world: FakeLinearWorld): Hono {
  const { clock } = context;
  const root = linearResolvers(world);
  const api = new Hono();

  api.post("/graphql", async (c) => {
    const startedAt = clock();
    const token = bearerFrom(c.req.header("authorization")) ?? c.req.header("authorization") ?? "";
    if (token === "") return c.json(authError("Authentication required, not authenticated"), 401);
    // A personal API key or anything else isn't the app.
    if (!constantTimeEqual(token, context.secret("oauthToken")))
      return c.json(authError("Authentication failed - invalid token"), 401);

    let request: GraphQLRequest;
    try {
      request = (await c.req.json()) as GraphQLRequest;
    } catch {
      return c.json(
        { errors: [{ message: "Request body is not valid JSON", extensions: { code: "BAD_REQUEST" } }] },
        400,
      );
    }
    if (typeof request?.query !== "string")
      return c.json({ errors: [{ message: "A query is required", extensions: { code: "BAD_REQUEST" } }] }, 400);

    const callContext: LinearCallContext & { viewer: string } = { sessions: new Set(), viewer: world.store.appUser.id };
    const { document, result } = await runGraphQL(request, root, callContext);
    // A query GraphQL can't run (it doesn't parse, or asks for what the schema doesn't have) is a 400; the rest is a 200.
    const status = result.data === undefined && result.errors ? 400 : 200;
    const body = {
      ...(result.data === undefined ? {} : { data: result.data }),
      ...(result.errors ? { errors: result.errors.map((error) => error.toJSON()) } : {}),
    };
    const [first] = result.errors ?? [];
    const fields = rootFields(document, request.operationName);
    recordCall(
      context.events,
      "linear",
      callContext.sessions,
      {
        operation: fields[0] ?? request.operationName ?? "query",
        method: "POST",
        path: "/graphql",
        request: {
          query: request.query,
          variables: request.variables ?? {},
          ...(request.operationName ? { operationName: request.operationName } : {}),
        },
        responseStatus: status,
        response: body,
        error: first ? String(first.extensions?.code ?? "GRAPHQL_ERROR") : undefined,
        durationMs: clock() - startedAt,
      },
      { unattributed: "world" },
    );
    return c.json(body, status);
  });

  api.notFound((c) => c.json({ errors: [{ message: "Not found", extensions: { code: "NOT_FOUND" } }] }, 404));
  return api;
}
