import type { LiveCheck, LiveMaintenance, SweepReport } from "../../../core/router/index.ts";
import { Allowlist, taggedRun } from "../../../core/safety/index.ts";
import { LiveVault } from "../../../core/secrets/index.ts";
import { removeGitHubEntry } from "./cleanup.ts";
import { type GitHubCaller, GitHubLiveClient } from "./client.ts";

const PERSON = /^CHANNELSTACK_GITHUB_USER_([A-Z0-9_]+)_TOKEN$/;
const ALLOWLIST = "CHANNELSTACK_LIVE_GITHUB_ORGS";

type Env = Readonly<Record<string, string | undefined>>;

interface Install {
  id: number;
  account: { login: string; type: string } | null;
  repository_selection: "all" | "selected";
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The App's client from the environment, and its installations, or why GitHub refused them. */
async function appOf(env: Env, fetch: typeof globalThis.fetch, apiBase: string | undefined) {
  const vault = new LiveVault(env, () => {});
  const appId = vault.setting("CHANNELSTACK_GITHUB_APP_ID");
  const key = vault.fromEnv("CHANNELSTACK_GITHUB_PRIVATE_KEY", "app");
  const client = new GitHubLiveClient({ base: apiBase, fetch, app: appId && key ? { appId, key } : undefined });
  if (!appId || !key)
    return { client, vault, problem: "CHANNELSTACK_GITHUB_APP_ID and CHANNELSTACK_GITHUB_PRIVATE_KEY are both needed" };
  try {
    const app = await client.call<{ slug: string }>({ app: true }, "GET /app");
    const installs = await client.all<Install>({ app: true }, "GET /app/installations");
    return { client, vault, app, installs, key };
  } catch (error) {
    return { client, vault, problem: message(error) };
  }
}

/** `channelstack doctor` and `channelstack sweep` for GitHub, from the credentials in the environment. */
export const githubMaintenance: LiveMaintenance = {
  async doctor({ env, fetch, apiBase }) {
    const allowlist = new Allowlist(ALLOWLIST, env);
    const found = await appOf(env, fetch, apiBase);
    const checks: LiveCheck[] = [];
    if ("problem" in found) {
      checks.push({ ok: false, text: `the GitHub App: ${found.problem}` });
    } else {
      const shown = `CHANNELSTACK_GITHUB_PRIVATE_KEY (${found.key.prefix()}…)`;
      const usable = found.installs.filter((install) => install.account && allowlist.allows(install.account.login));
      const install = usable[0];
      if (!install?.account) {
        const where = found.installs.map((candidate) => candidate.account?.login).filter(Boolean);
        checks.push({
          ok: false,
          text: `${shown}: the App ${found.app.slug} is installed on ${where.join(", ") || "nothing"}, and none of it is in ${ALLOWLIST}`,
        });
      } else if (install.account.type !== "Organization") {
        checks.push({
          ok: false,
          text: `${shown}: the App ${found.app.slug} is installed on ${install.account.login}, a user account; live GitHub needs a test organization`,
        });
      } else {
        // The same checks the live world makes, so doctor and a live run never disagree.
        checks.push({
          ok: true,
          text: `${shown}: the App ${found.app.slug} on ${install.account.login} (${install.repository_selection === "all" ? "all repositories" : "selected repositories: apps: [github.app] needs all"})`,
        });
      }
    }
    for (const variable of Object.keys(env)
      .filter((name) => PERSON.test(name))
      .sort()) {
      const credential = found.vault.fromEnv(variable, `user:${PERSON.exec(variable)?.[1]}`);
      if (!credential) continue;
      const shown = `${variable} (${credential.prefix()}…)`;
      try {
        const who = await found.client.call<{ login: string; type: string }>({ token: credential }, "GET /user");
        checks.push(
          who.type === "User"
            ? { ok: true, text: `${shown}: ${who.login}` }
            : { ok: false, text: `${shown}: acts as ${who.login}, not a person` },
        );
      } catch (error) {
        checks.push({ ok: false, text: `${shown}: ${message(error)}` });
      }
    }
    return checks;
  },

  async sweep({ env, fetch, apiBase, entries, check, run, olderThanMs, now }) {
    const allowlist = new Allowlist(ALLOWLIST, env);
    const found = await appOf(env, fetch, apiBase);
    const report: SweepReport = { removed: [], left: [], done: [] };
    const install =
      "problem" in found
        ? undefined
        : found.installs.find(
            (candidate) => candidate.account?.type === "Organization" && allowlist.allows(candidate.account.login),
          );
    const caller: GitHubCaller | undefined = install ? { installation: install.id } : undefined;

    for (const entry of [...entries].reverse()) {
      const what = `${entry.kind} ${entry.ref.repo ?? entry.ref.name ?? ""} (run ${entry.run})`;
      if (!allowlist.allows(entry.workspace)) report.left.push(`${what}: org ${entry.workspace} isn't in ${ALLOWLIST}`);
      else if (check) report.left.push(what);
      else if (!caller) report.left.push(`${what}: the App isn't installed on an allowlisted organization`);
      else {
        try {
          await removeGitHubEntry(found.client, caller, entry);
          report.removed.push(what);
          report.done.push(entry);
        } catch (error) {
          report.left.push(`${what}: ${message(error)}`);
        }
      }
    }

    // Tagged repositories no ledger knows: a run's own (any age), or every run's older than the cutoff.
    if (!install?.account || !caller) return report;
    const org = install.account.login;
    const done = new Set(report.done.map((entry) => String(entry.ref.repo)));
    const repos = await found.client.all<{ name: string; created_at: string }>(caller, "GET /orgs/{org}/repos", {
      org,
    });
    for (const repo of repos) {
      const tagged = taggedRun(repo.name);
      if (tagged === undefined || done.has(`${org}/${repo.name}`)) continue;
      if (run !== undefined ? tagged !== run : now - Date.parse(repo.created_at) < olderThanMs) continue;
      if (check) {
        report.left.push(`repo ${org}/${repo.name}`);
        continue;
      }
      try {
        await removeGitHubEntry(found.client, caller, {
          id: repo.name,
          channel: "github",
          kind: "repo",
          ref: { repo: `${org}/${repo.name}`, name: repo.name },
          workspace: org,
          by: "app",
          run: tagged,
          session: "",
          createdAt: 0,
        });
        report.removed.push(`repo ${org}/${repo.name}`);
      } catch (error) {
        report.left.push(`repo ${org}/${repo.name}: ${message(error)}`);
      }
    }
    return report;
  },
};
