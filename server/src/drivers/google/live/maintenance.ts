import { credentialChecks, liveCredentials, sweepLedger, sweepTagged } from "../../../core/maintenance/index.ts";
import type { LiveMaintenance } from "../../../core/router/index.ts";
import { Allowlist } from "../../../core/safety/index.ts";
import { LiveCredential } from "../../../core/secrets/index.ts";
import { GoogleRestClient } from "./client.ts";
import { checkGoogleCredential, identifyGoogle } from "./identity.ts";

const ALLOWLIST = "CHANNELSTACK_LIVE_GOOGLE_ADDRESSES";

type Env = Readonly<Record<string, string | undefined>>;

/** The client, with the agent's OAuth client from the environment: every refresh token is from it. */
const clientFor = (env: Env, input: { fetch: typeof fetch; apiBase?: string | undefined }) =>
  new GoogleRestClient({
    base: input.apiBase,
    fetch: input.fetch,
    client: () => ({
      id: env.CHANNELSTACK_GOOGLE_CLIENT_ID ?? "",
      secret: new LiveCredential("app", env.CHANNELSTACK_GOOGLE_CLIENT_SECRET ?? ""),
    }),
  });

/** The agent's mailbox and every person's in the environment, each with its address, or why Google refused it. */
const credentials = (client: GoogleRestClient, env: Env) =>
  liveCredentials(env, {
    channel: "google",
    own: [{ variable: "CHANNELSTACK_GOOGLE_REFRESH_TOKEN", owner: "app" }],
    identify: (credential) => identifyGoogle(client, credential),
  });

/** `channelstack doctor` and `channelstack sweep` for Google, from the credentials in the environment. */
export const googleMaintenance: LiveMaintenance = {
  async doctor({ env, fetch, apiBase }) {
    const client = clientFor(env, { fetch, apiBase });
    const allowlist = new Allowlist(ALLOWLIST, env);
    return credentialChecks(await credentials(client, env), ({ variable, credential, who }) => {
      const address = checkGoogleCredential(who, { who: variable, allowlist });
      return `${credential.owner === "app" ? "the agent's mailbox" : "a person's mailbox"}, ${address}`;
    });
  },

  async sweep({ env, fetch, apiBase, entries, check, run, olderThanMs, now }) {
    const client = clientFor(env, { fetch, apiBase });
    const allowlist = new Allowlist(ALLOWLIST, env);
    const usable = (await credentials(client, env)).filter(
      ({ who }) => who !== undefined && allowlist.allows(who.address),
    );
    const byOwner = (owner: string) => usable.find(({ credential }) => credential.owner === owner)?.credential;
    const report = await sweepLedger(entries, {
      allowlist,
      check,
      describe: (entry) => `${entry.kind} ${entry.ref.name ?? entry.ref.thread ?? entry.ref.label ?? ""}`,
      remove: async (entry) => {
        const credential = byOwner(entry.by);
        if (!credential) throw new Error(`no credential for ${entry.by} in the environment`);
        if (entry.kind === "label") await client.deleteLabel(credential, entry.ref.label ?? "");
        else await client.trashThread(credential, entry.ref.thread ?? "");
      },
    });

    // Run-labelled threads no ledger knows: each mailbox's `channelstack-run-…` labels, and their threads.
    // Gmail's ids are a mailbox's own: each is known by its mailbox too.
    const threads: Array<{ thread: string; label: string; mailbox: string; by: LiveCredential; at: number }> = [];
    const runLabels: Array<{ id: string; name: string; mailbox: string; by: LiveCredential; at: number }> = [];
    /** When a thread was written: its first message's date. */
    const dateOf = async (credential: LiveCredential, thread: string) => {
      const { messages = [] } = await client.call<{ messages?: Array<{ internalDate?: string }> }>(
        credential,
        "GET",
        `gmail/v1/users/me/threads/${thread}?format=minimal`,
      );
      return Number(messages[0]?.internalDate) || 0;
    };
    for (const { credential, who } of usable) {
      const mailbox = who?.address ?? "";
      const { labels = [] } = await client.call<{ labels?: Array<{ id: string; name: string }> }>(
        credential,
        "GET",
        "gmail/v1/users/me/labels",
      );
      for (const label of labels.filter((each) => each.name.startsWith("channelstack-run-"))) {
        const listed = await client.call<{ threads?: Array<{ id: string; historyId?: string }> }>(
          credential,
          "GET",
          `gmail/v1/users/me/threads?labelIds=${label.id}&maxResults=500`,
        );
        let newest = 0;
        for (const { id } of listed.threads ?? []) {
          const at = await dateOf(credential, id);
          newest = Math.max(newest, at);
          threads.push({ thread: id, label: label.name, mailbox, by: credential, at });
        }
        if (newest === 0) {
          // No thread outside the trash has it: a trashed one dates it, or it counts as new, so
          // only a sweep of its own run removes it (a session may have just made it).
          const trashed = await client.call<{ threads?: Array<{ id: string }> }>(
            credential,
            "GET",
            `gmail/v1/users/me/threads?labelIds=${label.id}&includeSpamTrash=true&maxResults=1`,
          );
          const [first] = trashed.threads ?? [];
          newest = (first && (await dateOf(credential, first.id))) || now;
        }
        runLabels.push({ id: label.id, name: label.name, mailbox, by: credential, at: newest });
      }
    }
    const swept = await sweepTagged(report, threads, {
      entries,
      run,
      olderThanMs,
      now,
      check,
      name: (item) => `thread ${item.label} ${item.thread}`,
      known: (item, entry) =>
        entry.channel === "google" && entry.workspace === item.mailbox && entry.ref.thread === item.thread,
      createdAt: (item) => item.at,
      remove: async (item) => {
        await client.trashThread(item.by, item.thread);
        return undefined;
      },
    });
    // Then the labels themselves, once no thread outside the trash has one: Gmail keeps a mailbox's labels for good.
    return sweepTagged(swept, runLabels, {
      entries,
      run,
      olderThanMs,
      now,
      check,
      name: (item) => `label ${item.name}`,
      known: (item, entry) =>
        entry.channel === "google" && entry.workspace === item.mailbox && entry.ref.label === item.id,
      createdAt: (item) => item.at,
      remove: async (item) => {
        const left = await client.call<{ threads?: unknown[] }>(
          item.by,
          "GET",
          `gmail/v1/users/me/threads?labelIds=${item.id}&maxResults=1`,
        );
        if ((left.threads ?? []).length > 0) return "a thread outside the trash still has it";
        await client.deleteLabel(item.by, item.id);
        return undefined;
      },
    });
  },
};
