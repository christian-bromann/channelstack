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

/** Trash a thread a run left, as the mailbox it is in. */
const trash = (client: GoogleRestClient, credential: LiveCredential, thread: string) =>
  client.call(credential, "POST", `gmail/v1/users/me/threads/${thread}/trash`);

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
      describe: (entry) => `thread ${entry.ref.name ?? entry.ref.thread ?? ""}`,
      remove: async (entry) => {
        const credential = byOwner(entry.by);
        if (!credential) throw new Error(`no credential for ${entry.by} in the environment`);
        await trash(client, credential, entry.ref.thread ?? "");
      },
    });

    // Run-labelled threads no ledger knows: each mailbox's `channelstack-run-…` labels, and their threads.
    const threads: Array<{ thread: string; label: string; by: LiveCredential; at: number }> = [];
    for (const { credential } of usable) {
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
        for (const { id } of listed.threads ?? []) {
          const { messages = [] } = await client.call<{ messages?: Array<{ internalDate?: string }> }>(
            credential,
            "GET",
            `gmail/v1/users/me/threads/${id}?format=minimal`,
          );
          threads.push({ thread: id, label: label.name, by: credential, at: Number(messages[0]?.internalDate) || 0 });
        }
      }
    }
    return sweepTagged(report, threads, {
      entries,
      run,
      olderThanMs,
      now,
      check,
      name: (item) => `thread ${item.label} ${item.thread}`,
      known: (item, entry) => entry.channel === "google" && entry.ref.thread === item.thread,
      createdAt: (item) => item.at,
      remove: async (item) => {
        await trash(client, item.by, item.thread);
        return undefined;
      },
    });
  },
};
