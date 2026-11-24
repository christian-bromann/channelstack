import { credentialChecks, liveCredentials, sweepLedger, sweepTagged } from "../../../core/maintenance/index.ts";
import type { LiveMaintenance } from "../../../core/router/index.ts";
import { Allowlist } from "../../../core/safety/index.ts";
import { deleteLinearTeam, removeLinearEntry } from "./cleanup.ts";
import { LinearGraphqlClient } from "./client.ts";
import { checkLinearCredential, identifyLinear } from "./identity.ts";

const ALLOWLIST = "CHANNELSTACK_LIVE_LINEAR_WORKSPACES";

type Env = Readonly<Record<string, string | undefined>>;

/** The app's credential and every person's in the environment, each with who it is, or why Linear refused it. */
const credentials = (client: LinearGraphqlClient, env: Env) =>
  liveCredentials(env, {
    channel: "linear",
    own: [{ variable: "CHANNELSTACK_LINEAR_APP_TOKEN", owner: "app" }],
    identify: (credential) => identifyLinear(client, credential),
  });

/** `channelstack doctor` and `channelstack sweep` for Linear, from the credentials in the environment. */
export const linearMaintenance: LiveMaintenance = {
  async doctor({ env, fetch, timers, apiBase }) {
    const client = new LinearGraphqlClient({ url: apiBase, fetch, timers });
    const allowlist = new Allowlist(ALLOWLIST, env);
    const found = await credentials(client, env);
    const appOrg = found.find((entry) => entry.credential.owner === "app")?.who?.org.id;
    return credentialChecks(found, ({ variable, credential, who }) => {
      const role = credential.owner === "app" ? "app" : "person";
      checkLinearCredential(who, { role, who: variable, allowlist, appOrg });
      return `${role === "app" ? "the app" : "a person"} in workspace ${who.org.id}`;
    });
  },

  async sweep({ env, fetch, timers, apiBase, entries, check, run, olderThanMs, now }) {
    const client = new LinearGraphqlClient({ url: apiBase, fetch, timers });
    const allowlist = new Allowlist(ALLOWLIST, env);
    const usable = (await credentials(client, env)).filter(
      ({ who }) => who !== undefined && allowlist.allows(who.org.id),
    );
    const byOwner = (owner: string) => usable.find(({ credential }) => credential.owner === owner)?.credential;
    const report = await sweepLedger(entries, {
      allowlist,
      check,
      describe: (entry) => `team ${entry.ref.name ?? entry.ref.team ?? ""}`,
      remove: (entry) => removeLinearEntry(client, byOwner, entry),
    });

    // Tagged teams no ledger knows, as any usable credential reads them; a person deletes one.
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
    const person = usable.find(({ credential }) => credential.owner !== "app")?.credential;
    return sweepTagged(report, teams.teams.nodes, {
      entries,
      run,
      olderThanMs,
      now,
      check,
      name: (team) => `team ${team.name}`,
      known: (team, entry) => entry.channel === "linear" && entry.ref.team === team.id,
      createdAt: (team) => Date.parse(team.createdAt),
      remove: async (team) => {
        if (!person) return "no person's key in the environment can delete a team";
        await deleteLinearTeam(client, person, team.id);
        return undefined;
      },
    });
  },
};
