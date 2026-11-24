import { credentialChecks, liveCredentials, sweepLedger, sweepTagged } from "../../../core/maintenance/index.ts";
import type { LiveCheck, LiveMaintenance } from "../../../core/router/index.ts";
import { Allowlist } from "../../../core/safety/index.ts";
import { LiveVault } from "../../../core/secrets/index.ts";
import { deleteGitHubRepo, removeGitHubEntry } from "./cleanup.ts";
import { type GitHubCaller, GitHubLiveClient } from "./client.ts";
import { checkGitHubPerson, identifyApp, identifyPerson, testOrg } from "./identity.ts";

const ALLOWLIST = "CHANNELSTACK_LIVE_GITHUB_ORGS";

type Env = Readonly<Record<string, string | undefined>>;

/** The App's client from the environment: its id and private key, when both are set. */
function clientOf(env: Env, fetch: typeof globalThis.fetch, apiBase: string | undefined) {
  const vault = new LiveVault(env, () => {});
  const appId = vault.setting("CHANNELSTACK_GITHUB_APP_ID");
  const key = vault.fromEnv("CHANNELSTACK_GITHUB_PRIVATE_KEY", "app");
  const client = new GitHubLiveClient({ base: apiBase, fetch, app: appId && key ? { appId, key } : undefined });
  return { client, key: appId ? key : undefined };
}

/** The test org's installation, by the same check the live world makes, or why there is none. */
async function installation(client: GitHubLiveClient, allowlist: Allowlist) {
  const identity = await identifyApp(client);
  return { identity, install: testOrg(identity, allowlist) };
}

/** `channelstack doctor` and `channelstack sweep` for GitHub, from the credentials in the environment. */
export const githubMaintenance: LiveMaintenance = {
  async doctor({ env, fetch, apiBase }) {
    const allowlist = new Allowlist(ALLOWLIST, env);
    const { client, key } = clientOf(env, fetch, apiBase);
    const checks: LiveCheck[] = [];
    if (!key) {
      checks.push({
        ok: false,
        text: "the GitHub App: CHANNELSTACK_GITHUB_APP_ID and CHANNELSTACK_GITHUB_PRIVATE_KEY are both needed",
      });
    } else {
      try {
        const { identity, install } = await installation(client, allowlist);
        const covers =
          install.selection === "all" ? "all repositories" : "selected repositories: apps: [github.app] needs all";
        checks.push({
          ok: true,
          text: `CHANNELSTACK_GITHUB_PRIVATE_KEY (${key.prefix()}…): the App ${identity.app.slug} on ${install.account.login} (${covers})`,
        });
      } catch (error) {
        checks.push({ ok: false, text: `the GitHub App: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    const people = await liveCredentials(env, {
      channel: "github",
      own: [],
      identify: (credential) => identifyPerson(client, credential),
    });
    checks.push(
      ...credentialChecks(people, ({ variable, who }) => {
        checkGitHubPerson(who, { who: variable });
        return who.login;
      }),
    );
    return checks;
  },

  async sweep({ env, fetch, apiBase, entries, check, run, olderThanMs, now }) {
    const allowlist = new Allowlist(ALLOWLIST, env);
    const { client, key } = clientOf(env, fetch, apiBase);
    let caller: GitHubCaller | undefined;
    let org = "";
    let missing = "the App's credentials aren't set";
    if (key) {
      try {
        const { install } = await installation(client, allowlist);
        caller = { installation: install.id };
        org = install.account.login;
      } catch (error) {
        missing = error instanceof Error ? error.message : String(error);
      }
    }
    const report = await sweepLedger(entries, {
      allowlist,
      check,
      describe: (entry) => `repo ${entry.ref.repo ?? entry.ref.name ?? ""}`,
      remove: async (entry) => {
        if (!caller) throw new Error(missing);
        await removeGitHubEntry(client, caller, entry);
      },
    });
    if (!caller) return report;
    const installed = caller;
    // Tagged repositories no ledger knows: the org's, as its installation sees them.
    const repos = await client.all<{ name: string; created_at: string }>(installed, "GET /orgs/{org}/repos", { org });
    return sweepTagged(report, repos, {
      entries,
      run,
      olderThanMs,
      now,
      check,
      name: (repo) => `repo ${org}/${repo.name}`,
      known: (repo, entry) => entry.channel === "github" && entry.ref.repo === `${org}/${repo.name}`,
      createdAt: (repo) => Date.parse(repo.created_at),
      remove: async (repo) => {
        await deleteGitHubRepo(client, installed, `${org}/${repo.name}`);
        return undefined;
      },
    });
  },
};
