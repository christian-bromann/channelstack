import { createPrivateKey } from "node:crypto";

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

import { liveMisconfigured } from "../../../core/reality/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import { GitHubRefusal } from "../fake/kit.ts";

/** Real GitHub's REST API. Only `createApp` can point the client elsewhere (a stub in unit tests), never the environment. */
const GITHUB_API = "https://api.github.com";

/** Octokit logs requests and deprecations: nothing of it belongs in channelstack's output. */
const SILENT = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

type Params = Record<string, unknown>;

/** GitHub's answer to a refused request, as the refusal the fake gives too; anything else as it is. */
function refusal(error: unknown, route: string): unknown {
  const failed = error as { status?: unknown; response?: { data?: { message?: unknown; errors?: unknown } } };
  if (typeof failed.status !== "number") return error;
  const said = failed.response?.data?.message;
  const errors = failed.response?.data?.errors;
  return new GitHubRefusal(
    failed.status,
    `GitHub refused ${route}: ${typeof said === "string" ? said : `HTTP ${failed.status}`}`,
    Array.isArray(errors) ? errors : undefined,
  );
}

/** Who a call goes as: a person's token, the App itself (its JWT), or its installation on the test org. */
export type GitHubCaller = { token: LiveCredential } | { app: true } | { installation: number };

/**
 * Calls GitHub's REST API through Octokit, as a person (their token), as the App (a JWT from its
 * id and private key) or as its installation (a token `@octokit/auth-app` exchanges and renews).
 * A refusal is a `GitHubRefusal` with GitHub's status and message, the same the fake answers with,
 * never a token.
 */
export class GitHubLiveClient {
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #app: { appId: string; key: LiveCredential } | undefined;
  readonly #people = new Map<LiveCredential, Octokit>();
  #asApp: Octokit | undefined;
  readonly #installations = new Map<number, Octokit>();

  constructor(options: {
    base: string | undefined;
    fetch: typeof fetch;
    app: { appId: string; key: LiveCredential } | undefined;
  }) {
    this.#base = options.base ?? GITHUB_API;
    this.#fetch = options.fetch;
    this.#app = options.app;
  }

  #octokit(caller: GitHubCaller): Octokit {
    const common = { baseUrl: this.#base, request: { fetch: this.#fetch }, log: SILENT, userAgent: "channelstack" };
    if ("token" in caller) {
      let octokit = this.#people.get(caller.token);
      if (!octokit) {
        octokit = new Octokit({ ...common, auth: caller.token.reveal() });
        this.#people.set(caller.token, octokit);
      }
      return octokit;
    }
    if (!this.#app) throw new Error("The GitHub App's credentials aren't set");
    // A PEM in one environment line has `\n` for its line breaks.
    const privateKey = this.#app.key.reveal().replaceAll("\\n", "\n");
    try {
      // Checked here, before anything is sent: a key that can't sign makes no request at all.
      createPrivateKey(privateKey);
    } catch {
      throw liveMisconfigured(
        "CHANNELSTACK_GITHUB_PRIVATE_KEY isn't a private key",
        "set the App's private key, the PEM GitHub gave (in one line, with \\n for its line breaks)",
      );
    }
    const auth = { appId: this.#app.appId, privateKey };
    if ("app" in caller) {
      this.#asApp ??= new Octokit({ ...common, authStrategy: createAppAuth, auth });
      return this.#asApp;
    }
    let octokit = this.#installations.get(caller.installation);
    if (!octokit) {
      octokit = new Octokit({
        ...common,
        authStrategy: createAppAuth,
        auth: { ...auth, installationId: caller.installation },
      });
      this.#installations.set(caller.installation, octokit);
    }
    return octokit;
  }

  /** One request, by its route (`POST /repos/{owner}/{repo}/issues`): GitHub's status and answer. */
  async request<T = Record<string, unknown>>(
    caller: GitHubCaller,
    route: string,
    params: Params = {},
  ): Promise<{ status: number; data: T }> {
    try {
      const response = await this.#octokit(caller).request(route, params);
      return { status: response.status, data: response.data as T };
    } catch (error) {
      throw refusal(error, route);
    }
  }

  /** Its answer only. */
  async call<T = Record<string, unknown>>(caller: GitHubCaller, route: string, params: Params = {}): Promise<T> {
    return (await this.request<T>(caller, route, params)).data;
  }

  /** Every item of a paginated list, page by page. */
  async all<T>(caller: GitHubCaller, route: string, params: Params = {}): Promise<T[]> {
    try {
      return (await this.#octokit(caller).paginate(route, { per_page: 100, ...params })) as T[];
    } catch (error) {
      throw refusal(error, route);
    }
  }
}
