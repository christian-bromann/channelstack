import { credentialChecks, liveCredentials, sweepLedger, sweepTagged } from "../../../core/maintenance/index.ts";
import type { LiveMaintenance } from "../../../core/router/index.ts";
import { Allowlist } from "../../../core/safety/index.ts";
import { LiveVault } from "../../../core/secrets/index.ts";
import { archiveTagged, removeSlackEntry, taggedChannels } from "./cleanup.ts";
import { SlackWebClient } from "./client.ts";
import { checkSlackCredential, identify } from "./identity.ts";
import { signedInToSlack, SLACK_CLIENT, SLACK_COOKIE_DOMAINS } from "./ui.ts";

/** The app's and every person's credentials in the environment, with who each is in Slack (or why Slack refused it). */
const identities = (client: SlackWebClient, env: Readonly<Record<string, string | undefined>>) =>
  liveCredentials(env, {
    channel: "slack",
    own: [{ variable: "CHANNELSTACK_SLACK_BOT_TOKEN", owner: "app" }],
    identify: (credential) => identify(client, credential),
  });

/** `channelstack doctor`, `sweep` and `login` for Slack, from the credentials in the environment. */
export const slackMaintenance: LiveMaintenance = {
  async signIn({ env, fetch, timers, apiBase }) {
    // The sandbox workspace's own sign-in page, from the app's bot token: a person signs in there by hand.
    const client = new SlackWebClient({ base: apiBase, fetch, timers });
    const bot = new LiveVault(env, () => {}).fromEnv("CHANNELSTACK_SLACK_BOT_TOKEN");
    if (!bot) throw new Error("CHANNELSTACK_SLACK_BOT_TOKEN isn't set: it says which workspace to sign in to");
    const who = await identify(client, bot);
    checkSlackCredential(who, {
      role: "app",
      who: "CHANNELSTACK_SLACK_BOT_TOKEN",
      allowlist: new Allowlist("CHANNELSTACK_LIVE_SLACK_TEAMS", env),
    });
    return {
      start: who.url,
      origins: [new URL(who.url).origin, SLACK_CLIENT],
      signedIn: signedInToSlack,
      cookieDomains: SLACK_COOKIE_DOMAINS,
    };
  },

  async doctor({ env, fetch, timers, apiBase }) {
    const client = new SlackWebClient({ base: apiBase, fetch, timers });
    const allowlist = new Allowlist("CHANNELSTACK_LIVE_SLACK_TEAMS", env);
    const found = await identities(client, env);
    const app = found.find((entry) => entry.credential.owner === "app")?.who;
    return credentialChecks(found, ({ variable, credential, who }) => {
      const role = credential.owner === "app" ? "app" : "person";
      checkSlackCredential(who, { role, who: variable, allowlist, appTeam: app?.team });
      return `${role === "app" ? "the app's bot" : "a person"} in workspace ${who.team}`;
    });
  },

  async sweep({ env, fetch, timers, apiBase, entries, check, run, olderThanMs, now }) {
    const client = new SlackWebClient({ base: apiBase, fetch, timers });
    const allowlist = new Allowlist("CHANNELSTACK_LIVE_SLACK_TEAMS", env);
    const found = (await identities(client, env)).filter(
      (entry) => entry.who !== undefined && allowlist.allows(entry.who.team),
    );
    const byOwner = (owner: string) => found.find((entry) => entry.credential.owner === owner)?.credential;
    const byUser = (userId: string) => found.find((entry) => entry.who?.user === userId)?.credential;
    const report = await sweepLedger(entries, {
      allowlist,
      check,
      describe: (entry) => `${entry.kind} ${entry.ref.name ?? entry.ref.channel ?? ""}`,
      remove: (entry) => removeSlackEntry(client, { byOwner, byUser }, entry),
    });

    // Tagged channels nobody archived, as the environment's credentials see them.
    const channels = await taggedChannels(
      client,
      found.map((entry) => entry.credential),
      run,
    );
    return sweepTagged(report, channels, {
      entries,
      run,
      olderThanMs,
      now,
      check,
      name: (channel) => `channel #${channel.name}`,
      known: (channel, entry) => entry.channel === "slack" && entry.ref.channel === channel.id,
      createdAt: (channel) => channel.created * 1000,
      remove: async (channel) =>
        (await archiveTagged(client, channel)) ? undefined : "no credential in the environment is a member",
    });
  },
};
