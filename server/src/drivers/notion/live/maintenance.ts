import type { LiveCheck, LiveMaintenance, SweepReport } from "../../../core/router/index.ts";
import { Allowlist, taggedRun } from "../../../core/safety/index.ts";
import { type LiveCredential, LiveVault } from "../../../core/secrets/index.ts";
import { removeNotionEntry } from "./cleanup.ts";
import { NotionRestClient } from "./client.ts";
import { checkNotionCredential, identifyNotion, type NotionIdentity } from "./identity.ts";

const PERSON = /^CHANNELSTACK_NOTION_USER_([A-Z0-9_]+)_TOKEN$/;
const ALLOWLIST = "CHANNELSTACK_LIVE_NOTION_WORKSPACES";

type Env = Readonly<Record<string, string | undefined>>;

/** The integration's credential and every person's in the environment, each with who it is, or why Notion refused it. */
async function credentials(client: NotionRestClient, env: Env) {
  const vault = new LiveVault(env, () => {});
  const named = Object.keys(env)
    .filter((variable) => PERSON.test(variable))
    .sort()
    .map((variable) => ({ variable, owner: `user:${PERSON.exec(variable)?.[1]}` }));
  const found: Array<{ variable: string; credential: LiveCredential; who?: NotionIdentity; problem?: string }> = [];
  for (const { variable, owner } of [{ variable: "CHANNELSTACK_NOTION_TOKEN", owner: "app" }, ...named]) {
    const credential = vault.fromEnv(variable, owner);
    if (!credential) continue;
    const who = await identifyNotion(client, credential).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    found.push(typeof who === "string" ? { variable, credential, problem: who } : { variable, credential, who });
  }
  return found;
}

interface WireTitled {
  id: string;
  created_time: string;
  in_trash?: boolean;
  archived?: boolean;
  properties: Record<string, { type: string; title?: Array<{ plain_text: string }> }>;
}

const titleOf = (page: WireTitled) =>
  (Object.values(page.properties).find((property) => property.type === "title")?.title ?? [])
    .map((item) => item.plain_text)
    .join("");

/** `channelstack doctor` and `channelstack sweep` for Notion, from the credentials in the environment. */
export const notionMaintenance: LiveMaintenance = {
  async doctor({ env, fetch, apiBase }) {
    const client = new NotionRestClient({ base: apiBase, fetch });
    const allowlist = new Allowlist(ALLOWLIST, env);
    const found = await credentials(client, env);
    const appWorkspace = found.find((entry) => entry.credential.owner === "app")?.who?.workspace.id;
    return found.map(({ variable, credential, who, problem }): LiveCheck => {
      const shown = `${variable} (${credential.prefix()}…)`;
      if (!who) return { ok: false, text: `${shown}: ${problem}` };
      const role = credential.owner === "app" ? "app" : "person";
      try {
        // The same check the live world makes, so doctor and a live run never disagree.
        checkNotionCredential(who, { role, who: variable, allowlist, appWorkspace });
        return {
          ok: true,
          text: `${shown}: ${role === "app" ? "the integration" : "a person"} in workspace ${who.workspace.id}`,
        };
      } catch (error) {
        return { ok: false, text: `${shown}: ${error instanceof Error ? error.message : String(error)}` };
      }
    });
  },

  async sweep({ env, fetch, apiBase, entries, check, run, olderThanMs, now }) {
    const client = new NotionRestClient({ base: apiBase, fetch });
    const allowlist = new Allowlist(ALLOWLIST, env);
    const usable = (await credentials(client, env)).filter(
      ({ who }) => who !== undefined && allowlist.allows(who.workspace.id),
    );
    const byOwner = (owner: string) => usable.find(({ credential }) => credential.owner === owner)?.credential;
    const report: SweepReport = { removed: [], left: [], done: [] };

    for (const entry of [...entries].reverse()) {
      const what = `${entry.kind} ${entry.ref.name ?? entry.ref.page ?? ""} (run ${entry.run})`;
      if (!allowlist.allows(entry.workspace))
        report.left.push(`${what}: workspace ${entry.workspace} isn't in ${ALLOWLIST}`);
      else if (check) report.left.push(what);
      else {
        try {
          await removeNotionEntry(client, byOwner, entry);
          report.removed.push(what);
          report.done.push(entry);
        } catch (error) {
          report.left.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    // Tagged pages no ledger knows: a run's own (any age), or every run's older than the cutoff.
    // Each token searches what it can see: the integration's page, and the people's own pages.
    const done = new Set(report.done.map((entry) => entry.ref.page));
    const seen = new Set<string>();
    for (const { credential } of usable) {
      const pages = await client.all<WireTitled>(credential, "post", "search", {
        body: { query: "channelstack-run-", filter: { property: "object", value: "page" } },
      });
      for (const page of pages) {
        const title = titleOf(page);
        const tagged = taggedRun(title);
        if (tagged === undefined || page.in_trash || page.archived || done.has(page.id) || seen.has(page.id)) continue;
        if (run !== undefined ? tagged !== run : now - Date.parse(page.created_time) < olderThanMs) continue;
        seen.add(page.id);
        if (check) {
          report.left.push(`page ${title}`);
          continue;
        }
        try {
          await removeNotionEntry(client, () => credential, {
            id: page.id,
            channel: "notion",
            kind: "page",
            ref: { page: page.id, name: title },
            workspace: "",
            by: credential.owner,
            run: tagged,
            session: "",
            createdAt: 0,
          });
          report.removed.push(`page ${title}`);
        } catch (error) {
          report.left.push(`page ${title}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return report;
  },
};
