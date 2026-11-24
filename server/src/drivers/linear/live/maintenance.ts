import type { LiveCheck, LiveMaintenance, SweepReport } from "../../../core/router/index.ts";
import { Allowlist, taggedRun } from "../../../core/safety/index.ts";
import { type LiveCredential, LiveVault } from "../../../core/secrets/index.ts";
import { removeLinearEntry } from "./cleanup.ts";
import { LinearGraphqlClient } from "./client.ts";
import { checkLinearCredential, identifyLinear, type LinearIdentity } from "./identity.ts";

const PERSON = /^CHANNELSTACK_LINEAR_USER_([A-Z0-9_]+)_TOKEN$/;
const ALLOWLIST = "CHANNELSTACK_LIVE_LINEAR_WORKSPACES";

type Env = Readonly<Record<string, string | undefined>>;

/** The app's credential and every person's in the environment, each with who it is, or why Linear refused it. */
async function credentials(client: LinearGraphqlClient, env: Env) {
  const vault = new LiveVault(env, () => {});
  const named = Object.keys(env)
    .filter((variable) => PERSON.test(variable))
    .sort()
    .map((variable) => ({ variable, owner: `user:${PERSON.exec(variable)?.[1]}` }));
  const found: Array<{ variable: string; credential: LiveCredential; who?: LinearIdentity; problem?: string }> = [];
  for (const { variable, owner } of [{ variable: "CHANNELSTACK_LINEAR_APP_TOKEN", owner: "app" }, ...named]) {
    const credential = vault.fromEnv(variable, owner);
    if (!credential) continue;
    const who = await identifyLinear(client, credential).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    found.push(typeof who === "string" ? { variable, credential, problem: who } : { variable, credential, who });
  }
  return found;
}

/** `channelstack doctor` and `channelstack sweep` for Linear, from the credentials in the environment. */
export const linearMaintenance: LiveMaintenance = {
  async doctor({ env, fetch, timers, apiBase }) {
    const client = new LinearGraphqlClient({ url: apiBase, fetch, timers });
    const allowlist = new Allowlist(ALLOWLIST, env);
    const found = await credentials(client, env);
    const appOrg = found.find((entry) => entry.credential.owner === "app")?.who?.org.id;
    return found.map(({ variable, credential, who, problem }): LiveCheck => {
      const shown = `${variable} (${credential.prefix()}…)`;
      if (!who) return { ok: false, text: `${shown}: ${problem}` };
      const role = credential.owner === "app" ? "app" : "person";
      try {
        // The same check the live world makes, so doctor and a live run never disagree.
        checkLinearCredential(who, { role, who: variable, allowlist, appOrg });
        return { ok: true, text: `${shown}: ${role === "app" ? "the app" : "a person"} in workspace ${who.org.id}` };
      } catch (error) {
        return { ok: false, text: `${shown}: ${error instanceof Error ? error.message : String(error)}` };
      }
    });
  },

  async sweep({ env, fetch, timers, apiBase, entries, check, run, olderThanMs, now }) {
    const client = new LinearGraphqlClient({ url: apiBase, fetch, timers });
    const allowlist = new Allowlist(ALLOWLIST, env);
    const usable = (await credentials(client, env)).filter(
      ({ who }) => who !== undefined && allowlist.allows(who.org.id),
    );
    const byOwner = (owner: string) => usable.find(({ credential }) => credential.owner === owner)?.credential;
    const report: SweepReport = { removed: [], left: [], done: [] };

    for (const entry of [...entries].reverse()) {
      const what = `${entry.kind} ${entry.ref.name ?? entry.ref.team ?? ""} (run ${entry.run})`;
      if (!allowlist.allows(entry.workspace))
        report.left.push(`${what}: workspace ${entry.workspace} isn't in ${ALLOWLIST}`);
      else if (check) report.left.push(what);
      else {
        try {
          await removeLinearEntry(client, byOwner, entry);
          report.removed.push(what);
          report.done.push(entry);
        } catch (error) {
          report.left.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    // Tagged teams no ledger knows: a run's own (any age), or every run's older than the cutoff.
    const reader = usable[0]?.credential;
    if (!reader) return report;
    const teams = await client.call<{ teams: { nodes: Array<{ id: string; name: string; createdAt: string }> } }>(
      reader,
      /* GraphQL */ `
        query Teams {
          teams(first: 250) {
            nodes {
              id
              name
              createdAt
            }
          }
        }
      `,
    );
    const done = new Set(report.done.map((entry) => entry.ref.team));
    for (const team of teams.teams.nodes) {
      const tagged = taggedRun(team.name);
      if (tagged === undefined || done.has(team.id) || (run !== undefined && tagged !== run)) continue;
      if (run === undefined && now - Date.parse(team.createdAt) < olderThanMs) continue;
      if (check) {
        report.left.push(`team ${team.name}`);
        continue;
      }
      // A team is deleted by a person: the first whose key works here.
      const person = usable.find(({ credential }) => credential.owner !== "app")?.credential;
      const owner = person?.owner ?? "app";
      try {
        await removeLinearEntry(client, () => person, {
          id: team.id,
          channel: "linear",
          kind: "team",
          ref: { team: team.id, name: team.name },
          workspace: "",
          by: owner,
          run: tagged,
          session: "",
          createdAt: 0,
        });
        report.removed.push(`team ${team.name}`);
      } catch (error) {
        report.left.push(`team ${team.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return report;
  },
};
