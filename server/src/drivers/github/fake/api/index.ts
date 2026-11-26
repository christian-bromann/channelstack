import { type Context, Hono } from "hono";

import { bearerFrom } from "../../../../core/auth/index.ts";
import { ProtocolError } from "../../../../core/errors/index.ts";
import { bodyOf, wrapRest } from "../../../../core/fake/endpoint.ts";
import type { DriverContext } from "../../../../core/router/index.ts";
import { constantTimeEqual } from "../../../../core/signing/hmac.ts";
import { GITHUB_IDS } from "../../ids.ts";
import { githubTime } from "../../payloads.ts";
import { verifyGitHubAppJwt } from "../../signing.ts";
import type { GitHubRepoRecord } from "../../world.ts";
import { GitHubRefusal } from "../kit.ts";
import type { FakeGitHubWorld } from "../world.ts";
import { registerChecks } from "./checks.ts";
import { registerIssues } from "./issues.ts";
import { registerPulls } from "./pulls.ts";
import { registerRepos } from "./repos.ts";
import { type Json, notFound, page, type Register } from "./shared.ts";

const DOCS = "https://docs.github.com/rest";
const NOT_FOUND = { message: "Not Found", documentation_url: DOCS, status: "404" };
/** An installation token is good for an hour. */
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

type Variables = {
  repo?: GitHubRepoRecord;
  /** The request showed the App's JWT or its installation's token. Only such calls are on record. */
  authenticated?: boolean;
  /** A call about no repository that still belongs to one session: reading one of its deliveries. */
  session?: string;
};

/**
 * GitHub's REST API, as the agent's App sees it. It authenticates as GitHub does (the App's JWT
 * for the App's own endpoints, an installation token for everything else), refuses what GitHub
 * refuses with GitHub's status and message, and records every call about a repository for the
 * session that owns it.
 */
export function createGitHubApi(context: DriverContext, world: FakeGitHubWorld): Hono {
  const { clock } = context;
  const { store, objects } = world.kit;
  const routes = new Hono<{ Variables: Variables }>();

  const credential = (c: Context): string | undefined => {
    const header = c.req.header("authorization") ?? "";
    return bearerFrom(header) ?? /^token\s+(\S+)$/i.exec(header)?.[1];
  };
  const unauthorized = (message = "Bad credentials") => new GitHubRefusal(401, message);

  /** The App itself, by the JWT it signed with its private key. */
  const asApp = async (c: Context): Promise<void> => {
    const token = credential(c);
    const app = { privateKey: context.secret("privateKey"), issuers: [String(store.app.id), store.app.clientId] };
    if (token === undefined || !(await verifyGitHubAppJwt(token, app, clock()))) {
      throw unauthorized("A JSON web token could not be decoded");
    }
    c.set("authenticated", true);
  };

  /** The App's installation, by the token `POST /app/installations/{id}/access_tokens` handed out. */
  const asInstallation = (c: Context): void => {
    const token = credential(c);
    if (token === undefined) throw unauthorized("Requires authentication");
    if (!constantTimeEqual(token, context.secret("installationToken"))) throw unauthorized();
    c.set("authenticated", true);
  };

  // --- The App's own endpoints -------------------------------------------------------------

  routes.get("/app", async (c) => {
    await asApp(c);
    return c.json({ ...objects.integration(), installations_count: 1 });
  });

  routes.get("/app/installations", async (c) => {
    await asApp(c);
    return c.json(page(c, [objects.installation()]));
  });

  const installationOf = (c: Context): void => {
    if (c.req.param("installation") !== String(store.app.installationId)) throw notFound();
  };

  routes.get("/app/installations/:installation", async (c) => {
    await asApp(c);
    installationOf(c);
    return c.json(objects.installation());
  });

  routes.post("/app/installations/:installation/access_tokens", async (c) => {
    await asApp(c);
    installationOf(c);
    return c.json(
      {
        token: context.secret("installationToken"),
        expires_at: githubTime(clock() + TOKEN_LIFETIME_MS),
        permissions: { metadata: "read", ...store.app.permissions },
        repository_selection: "selected",
      },
      201,
    );
  });

  routes.get("/repos/:owner/:repo/installation", async (c) => {
    await asApp(c);
    const repo = store.repoNamed(c.req.param("owner"), c.req.param("repo"));
    if (!repo?.installed) throw notFound();
    // About a repository, so on record for its session, like the calls made with the token.
    c.set("repo", repo);
    return c.json(objects.installation());
  });

  routes.get("/orgs/:org/installation", async (c) => {
    await asApp(c);
    if (c.req.param("org").toLowerCase() !== store.org.login.toLowerCase()) throw notFound();
    return c.json(objects.installation());
  });

  /** One entry of the delivery log, with how its attempt went. */
  const hookDelivery = (entry: (typeof store.hookDeliveries)[number], detailed: boolean): Json => {
    const sameGuid = store.hookDeliveries.filter((other) => other.guid === entry.guid);
    const number = sameGuid.indexOf(entry);
    const record = world.kit.deliveries.delivery(entry.session, entry.guid);
    const attempt = record.attempts[number];
    const code = attempt?.responseStatus ?? 0;
    return {
      id: entry.id,
      guid: entry.guid,
      delivered_at: githubTime(entry.deliveredAt),
      redelivery: number > 0,
      duration: (attempt?.durationMs ?? 0) / 1000,
      status:
        attempt?.status === "acknowledged" ? "OK" : code === 0 ? "failed to connect to host" : "Invalid HTTP Response",
      status_code: code,
      event: entry.event,
      action: entry.action,
      installation_id: store.app.installationId,
      repository_id: entry.repo ?? null,
      throttled_at: null,
      ...(detailed
        ? {
            url: record.request.url,
            request: { headers: attempt?.requestHeaders ?? {}, payload: record.request.meta?.payload ?? {} },
            response: { headers: {}, payload: attempt?.responseBody ?? null },
          }
        : {}),
    };
  };

  routes.get("/app/hook/deliveries", async (c) => {
    await asApp(c);
    return c.json(page(c, [...store.hookDeliveries].reverse()).map((entry) => hookDelivery(entry, false)));
  });

  const hookEntry = (c: Context) => {
    const entry = store.hookDeliveries.find((candidate) => String(candidate.id) === c.req.param("delivery"));
    if (!entry) throw notFound();
    // One delivery belongs to one session: reading it, or sending it again, is on that session's record.
    c.set("session", entry.session);
    return entry;
  };

  routes.get("/app/hook/deliveries/:delivery", async (c) => {
    await asApp(c);
    return c.json(hookDelivery(hookEntry(c), true));
  });

  routes.post("/app/hook/deliveries/:delivery/attempts", async (c) => {
    await asApp(c);
    const entry = hookEntry(c);
    // GitHub accepts the request and redelivers on its own time.
    void world.redeliver(entry.session, entry.guid).catch(() => {});
    return c.json({}, 202);
  });

  // --- Everything an installation token reaches -----------------------------------------------

  routes.get("/installation/repositories", (c) => {
    asInstallation(c);
    const repositories = store.installedRepos().map((repo) => objects.propertiedRepository(repo));
    return c.json({ total_count: repositories.length, repositories: page(c, repositories) });
  });

  routes.get("/users/:login", (c) => {
    asInstallation(c);
    const user = store.anyByLogin(c.req.param("login"));
    if (!user) throw notFound();
    return c.json(objects.publicUser(user));
  });

  routes.get("/user", (c) => {
    asInstallation(c);
    throw new GitHubRefusal(403, "Resource not accessible by integration");
  });

  const register: Register = (method, path, [permission, level], handler) => {
    routes.on(method.toUpperCase(), `/repos/:owner/:repo${path}`, async (c) => {
      asInstallation(c);
      // A repository the App isn't installed on doesn't exist for its token.
      const repo = store.repoNamed(c.req.param("owner"), c.req.param("repo"));
      if (!repo?.installed) throw notFound();
      c.set("repo", repo);
      const granted = permission === "metadata" ? "read" : store.app.permissions[permission];
      if (granted === undefined || (level === "write" && granted !== "write")) {
        throw new GitHubRefusal(403, "Resource not accessible by integration");
      }
      // Any method may carry a body (GitHub's DELETE for assignees and files does): an object, or a
      // list where an endpoint takes one (labels).
      const parsed = method === "get" ? { body: {} } : await bodyOf(c);
      if ("invalid" in parsed) {
        throw parsed.invalid === "json"
          ? new GitHubRefusal(400, "Problems parsing JSON")
          : new GitHubRefusal(400, "Invalid request.\n\nThe request body must be a JSON object or array.");
      }
      return handler({ c, world, repo, body: parsed.body as Json, bot: store.bot.id });
    });
  };
  registerRepos(register);
  registerIssues(register);
  registerPulls(register);
  registerChecks(register);

  // Anything else isn't served: GitHub's 404, through the same error handling and recording as every route.
  routes.all("*", async (c) => {
    // Whoever asks gets the 404. It is on record when the App or its installation asked: for the
    // session that owns the repository the path names, or for no session when it names none.
    const token = credential(c) ?? "";
    const app = { privateKey: context.secret("privateKey"), issuers: [String(store.app.id), store.app.clientId] };
    if (
      constantTimeEqual(token, context.secret("installationToken")) ||
      (await verifyGitHubAppJwt(token, app, clock()))
    ) {
      c.set("authenticated", true);
      const [, owner = "", name = ""] = /\/repos\/([^/]+)\/([^/]+)/.exec(c.req.path) ?? [];
      const repo = store.repoNamed(owner, name);
      if (repo?.installed) c.set("repo", repo);
    }
    throw notFound();
  });

  // --- What wraps every request ------------------------------------------------------------

  const answer = (status: number, body: Json) => ({ status, body, sessions: [] });
  // Only what authenticated as the App or its installation is on record. A call about a
  // repository belongs to the session that owns it; one about a delivery, to the delivery's
  // session; the rest (the App's own endpoints, the token exchange) to no session, and the
  // core event log keeps those in the scope every session reads. GitHub Enterprise serves the
  // same API under `/api/v3`; SDKs that are given a host assume that layout.
  const github: Parameters<typeof wrapRest>[1] = {
    driver: "github",
    refusal: (error) => {
      if (error instanceof GitHubRefusal) {
        const status = error.githubStatus;
        return answer(status, {
          message: error.message,
          ...(error.errors ? { errors: error.errors } : {}),
          documentation_url: DOCS,
          status: String(status),
        });
      }
      // A handle the world doesn't know is GitHub's 404.
      if (error instanceof ProtocolError && error.code === "not_found") return answer(404, NOT_FOUND);
      return undefined;
    },
    internal: () => answer(500, { message: "Server Error", documentation_url: DOCS }),
    decorate: (answered) => ({
      ...answered,
      headers: {
        "x-github-media-type": "github.v3; format=json",
        "x-github-api-version-selected": "2022-11-28",
        "x-github-request-id": world.kit.context.ids
          .next(GITHUB_IDS.delivery)
          .toUpperCase()
          .replaceAll("-", ":")
          .slice(0, 34),
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4999",
        "x-ratelimit-used": "1",
        "x-ratelimit-reset": String(Math.floor(clock() / 1000) + 3600),
        "x-ratelimit-resource": "core",
      },
    }),
  };
  return wrapRest(context, github, routes, {
    recorded: (c) => c.get("authenticated") === true,
    sessions: (c) => {
      const repo = c.get("repo") as GitHubRepoRecord | undefined;
      return [repo ? store.sessionOf(repo) : (c.get("session") as string | undefined)];
    },
    mounts: ["/api/v3"],
  });
}
