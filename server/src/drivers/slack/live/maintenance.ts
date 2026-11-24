import type { LiveCheck, LiveMaintenance, SweepReport } from "../../../core/router/index.ts";
import { Allowlist } from "../../../core/safety/index.ts";
import { type LiveCredential, LiveVault } from "../../../core/secrets/index.ts";
import { SlackRefusal } from "../world.ts";
import { archiveTagged, removeSlackEntry, taggedChannels } from "./cleanup.ts";
import { SlackWebClient } from "./client.ts";
import { checkSlackCredential, identify, type SlackIdentity } from "./identity.ts";
import { SLACK_CLIENT } from "./ui.ts";

const PERSON = /^CHANNELSTACK_SLACK_USER_([A-Z0-9_]+)_TOKEN$/;

/** The app's and every person's credentials in the environment, with who each is in Slack (or why Slack refused it). */
async function identities(client: SlackWebClient, env: Readonly<Record<string, string | undefined>>) {
  const vault = new LiveVault(env, () => {});
  const found: Array<{ variable: string; credential: LiveCredential; who?: SlackIdentity; problem?: string }> = [];
  const variables = [
    "CHANNELSTACK_SLACK_BOT_TOKEN",
    ...Object.keys(env)
      .filter((name) => PERSON.test(name))
      .sort(),
  ];
  for (const variable of variables) {
    const owner = variable === "CHANNELSTACK_SLACK_BOT_TOKEN" ? "app" : `user:${PERSON.exec(variable)?.[1]}`;
    const credential = vault.fromEnv(variable, owner);
    if (!credential) continue;
    try {
      found.push({ variable, credential, who: await identify(client, credential) });
    } catch (error) {
      found.push({ variable, credential, problem: error instanceof SlackRefusal ? error.code : String(error) });
    }
  }
  return found;
}

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
      signedIn: (url) => url.startsWith(`${SLACK_CLIENT}/client/`),
      cookieDomains: ["slack.com"],
    };
  },

  async doctor({ env, fetch, timers, apiBase }) {
    const client = new SlackWebClient({ base: apiBase, fetch, timers });
    const allowlist = new Allowlist("CHANNELSTACK_LIVE_SLACK_TEAMS", env);
    const checks: LiveCheck[] = [];
    const found = await identities(client, env);
    const app = found.find((entry) => entry.credential.owner === "app")?.who;
    for (const entry of found) {
      const shown = `${entry.variable} (${entry.credential.prefix()}…)`;
      if (!entry.who) {
        checks.push({ ok: false, text: `${shown}: Slack refused it (${entry.problem})` });
        continue;
      }
      const role = entry.credential.owner === "app" ? "app" : "person";
      // The same check the live world makes, so doctor and a live run never disagree.
      try {
        checkSlackCredential(entry.who, { role, who: entry.variable, allowlist, appTeam: app?.team });
        checks.push({
          ok: true,
          text: `${shown}: ${role === "app" ? "the app's bot" : "a person"} in workspace ${entry.who.team}`,
        });
      } catch (error) {
        checks.push({ ok: false, text: `${shown}: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return checks;
  },

  async sweep({ env, fetch, timers, apiBase, entries, check, run, olderThanMs, now }) {
    const client = new SlackWebClient({ base: apiBase, fetch, timers });
    const allowlist = new Allowlist("CHANNELSTACK_LIVE_SLACK_TEAMS", env);
    const found = (await identities(client, env)).filter(
      (entry) => entry.who !== undefined && allowlist.allows(entry.who.team),
    );
    const report: SweepReport = { removed: [], left: [], done: [] };
    const byOwner = (owner: string) => found.find((entry) => entry.credential.owner === owner)?.credential;
    const byUser = (userId: string) => found.find((entry) => entry.who?.user === userId)?.credential;

    // What crashed runs recorded, in allowlisted workspaces only.
    for (const entry of [...entries].reverse()) {
      const what = `${entry.kind} ${entry.ref.name ?? entry.ref.channel ?? ""} (run ${entry.run})`;
      if (!allowlist.allows(entry.workspace)) {
        report.left.push(`${what}: workspace ${entry.workspace} isn't in CHANNELSTACK_LIVE_SLACK_TEAMS`);
        continue;
      }
      if (check) {
        report.left.push(what);
        continue;
      }
      try {
        await removeSlackEntry(client, { byOwner, byUser }, entry);
        report.removed.push(what);
        report.done.push(entry);
      } catch (error) {
        report.left.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Tagged channels nobody archived: a run's own (any age), or every run's older than the cutoff.
    const channels = await taggedChannels(
      client,
      found.map((entry) => entry.credential),
      run,
    );
    for (const channel of channels) {
      const old = now - channel.created * 1000 >= olderThanMs;
      if (run === undefined && !old) continue;
      if (check) {
        report.left.push(`channel #${channel.name}`);
        continue;
      }
      if (await archiveTagged(client, channel)) report.removed.push(`channel #${channel.name}`);
      else report.left.push(`channel #${channel.name}: no credential in the environment is a member`);
    }
    return report;
  },
};
