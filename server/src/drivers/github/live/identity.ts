import { liveMisconfigured } from "../../../core/reality/index.ts";
import type { Allowlist } from "../../../core/safety/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import type { GitHubLiveClient } from "./client.ts";

/** The agent's GitHub App, by its JWT: what it is, and where it is installed. */
export interface GitHubAppIdentity {
  readonly app: {
    readonly id: number;
    readonly slug: string;
    readonly name: string;
    readonly clientId: string;
    readonly events: readonly string[];
    readonly createdAt: number;
  };
  readonly installations: readonly GitHubInstallation[];
}

export interface GitHubInstallation {
  readonly id: number;
  readonly account: { readonly id: number; readonly login: string; readonly type: string };
  readonly selection: "all" | "selected";
  readonly permissions: Readonly<Record<string, "read" | "write">>;
}

/** A person's token, by `GET /user`. */
export interface GitHubPersonIdentity {
  readonly id: number;
  readonly login: string;
  readonly type: string;
}

export async function identifyApp(client: GitHubLiveClient): Promise<GitHubAppIdentity> {
  const app = await client.call<{
    id: number;
    slug: string;
    name: string;
    client_id?: string;
    events: string[];
    created_at: string;
  }>({ app: true }, "GET /app");
  const installs = await client.all<{
    id: number;
    account: { id: number; login: string; type: string } | null;
    repository_selection: "all" | "selected";
    permissions: Record<string, "read" | "write">;
  }>({ app: true }, "GET /app/installations");
  return {
    app: {
      id: app.id,
      slug: app.slug,
      name: app.name,
      clientId: app.client_id ?? "",
      events: app.events,
      createdAt: Date.parse(app.created_at),
    },
    installations: installs.flatMap((install) =>
      install.account
        ? [
            {
              id: install.id,
              account: install.account,
              selection: install.repository_selection,
              permissions: install.permissions,
            },
          ]
        : [],
    ),
  };
}

export async function identifyPerson(
  client: GitHubLiveClient,
  credential: LiveCredential,
): Promise<GitHubPersonIdentity> {
  const who = await client.call<GitHubPersonIdentity>({ token: credential }, "GET /user");
  return { id: who.id, login: who.login, type: who.type };
}

/**
 * The one check of the App, for the live world, `doctor` and `sweep` alike: the installation live
 * mode acts through is the App's on an allowlisted account, which must be an organization (only an
 * org lets the App make and delete the test repositories). Throws the refusal.
 */
export function testOrg(identity: GitHubAppIdentity, allowlist: Allowlist): GitHubInstallation {
  const [install] = identity.installations.filter((candidate) => allowlist.allows(candidate.account.login));
  if (!install) {
    const [elsewhere] = identity.installations;
    // An installation outside the allowlist is refused the way every live refusal of it is.
    if (elsewhere) allowlist.assert(elsewhere.account.login, `GitHub account ${elsewhere.account.login}`);
    throw liveMisconfigured(
      `the GitHub App ${identity.app.slug} isn't installed anywhere`,
      "install it on the test organization",
    );
  }
  if (install.account.type !== "Organization") {
    throw liveMisconfigured(
      `the GitHub App is installed on ${install.account.login}, a user account`,
      "install it on a test organization and allowlist that: only an organization lets the App make and delete the test repositories",
    );
  }
  return install;
}

/** The one check of a person's token: a person's, and, when the test names them, theirs. Throws the refusal. */
export function checkGitHubPerson(who: GitHubPersonIdentity, expected: { who: string; login?: string }): void {
  if (who.type !== "User") {
    throw liveMisconfigured(`${expected.who} acts as ${who.login}, not a person`, "use a machine user's token");
  }
  if (expected.login !== undefined && who.login.toLowerCase() !== expected.login.toLowerCase()) {
    throw liveMisconfigured(
      `${expected.login}'s token is ${who.login}'s`,
      "name the person by their GitHub login (createUser({ login }))",
    );
  }
}
