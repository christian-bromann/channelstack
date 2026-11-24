import { credentialChecks, liveCredentials, sweepLedger, sweepTagged } from "../../../core/maintenance/index.ts";
import type { LiveMaintenance } from "../../../core/router/index.ts";
import { Allowlist } from "../../../core/safety/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import { removeNotionEntry, trashNotionPage } from "./cleanup.ts";
import { NotionRestClient } from "./client.ts";
import { checkNotionCredential, identifyNotion } from "./identity.ts";

const ALLOWLIST = "CHANNELSTACK_LIVE_NOTION_WORKSPACES";

type Env = Readonly<Record<string, string | undefined>>;

/** The integration's credential and every person's in the environment, each with who it is, or why Notion refused it. */
const credentials = (client: NotionRestClient, env: Env) =>
  liveCredentials(env, {
    channel: "notion",
    own: [{ variable: "CHANNELSTACK_NOTION_TOKEN", owner: "app" }],
    identify: (credential) => identifyNotion(client, credential),
  });

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
    return credentialChecks(found, ({ variable, credential, who }) => {
      const role = credential.owner === "app" ? "app" : "person";
      checkNotionCredential(who, { role, who: variable, allowlist, appWorkspace });
      return `${role === "app" ? "the integration" : "a person"} in workspace ${who.workspace.id}`;
    });
  },

  async sweep({ env, fetch, apiBase, entries, check, run, olderThanMs, now }) {
    const client = new NotionRestClient({ base: apiBase, fetch });
    const allowlist = new Allowlist(ALLOWLIST, env);
    const usable = (await credentials(client, env)).filter(
      ({ who }) => who !== undefined && allowlist.allows(who.workspace.id),
    );
    const byOwner = (owner: string) => usable.find(({ credential }) => credential.owner === owner)?.credential;
    const report = await sweepLedger(entries, {
      allowlist,
      check,
      describe: (entry) => `page ${entry.ref.name ?? entry.ref.page ?? ""}`,
      remove: (entry) => removeNotionEntry(client, byOwner, entry),
    });

    // Tagged pages no ledger knows. Each token searches what it can see: the integration's page,
    // and the people's own pages; each page is removed by a token that found it.
    const pages = new Map<string, WireTitled & { by: LiveCredential }>();
    for (const { credential } of usable) {
      const found = await client.all<WireTitled>(credential, "post", "search", {
        body: { query: "channelstack-run-", filter: { property: "object", value: "page" } },
      });
      for (const page of found) {
        if (!page.in_trash && !page.archived && !pages.has(page.id)) pages.set(page.id, { ...page, by: credential });
      }
    }
    return sweepTagged(report, pages.values(), {
      entries,
      run,
      olderThanMs,
      now,
      check,
      name: (page) => `page ${titleOf(page)}`,
      known: (page, entry) => entry.channel === "notion" && entry.ref.page === page.id,
      createdAt: (page) => Date.parse(page.created_time),
      remove: async (page) => {
        await trashNotionPage(client, page.by, page.id);
        return undefined;
      },
    });
  },
};
