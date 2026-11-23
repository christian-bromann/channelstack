import type { LiveCheck, LiveMaintenance, SweepReport } from "../../../core/router/index.ts";
import { Allowlist } from "../../../core/safety/index.ts";
import { type LiveCredential, LiveVault } from "../../../core/secrets/index.ts";
import { SlackRefusal } from "../world.ts";
import { archiveTagged, removeSlackEntry, taggedChannels } from "./cleanup.ts";
import { SlackWebClient } from "./client.ts";

const PERSON = /^CHANNELSTACK_SLACK_USER_([A-Z0-9_]+)_TOKEN$/;

/** The app's and every person's credentials in the environment, with who each is in Slack. */
async function identities(client: SlackWebClient, env: Readonly<Record<string, string | undefined>>) {
  const vault = new LiveVault(env, () => {});
  const found: Array<{ variable: string; credential: LiveCredential; who?: { user: string; team: string; bot: boolean }; problem?: string }> = [];
  const variables = ["CHANNELSTACK_SLACK_BOT_TOKEN", ...Object.keys(env).filter((name) => PERSON.test(name)).sort()];
  for (const variable of variables) {
    const owner = variable === "CHANNELSTACK_SLACK_BOT_TOKEN" ? "app" : `user:${PERSON.exec(variable)?.[1]}`;
    const credential = vault.fromEnv(variable, owner);
    if (!credential) continue;
    try {
      const answer = await client.call("auth.test", credential);
      found.push({
        variable,
        credential,
        who: { user: String(answer.user_id), team: String(answer.team_id), bot: typeof answer.bot_id === "string" },
      });
    } catch (error) {
      found.push({ variable, credential, problem: error instanceof SlackRefusal ? error.code : String(error) });
    }
  }
  return found;
}

/** `channelstack doctor` and `channelstack sweep` for Slack, from the credentials in the environment. */
export const slackMaintenance: LiveMaintenance = {
  async doctor({ env, fetch, timers, apiBase }) {
    const client = new SlackWebClient({ base: apiBase, fetch, timers });
    const allowlist = new Allowlist("CHANNELSTACK_LIVE_SLACK_TEAMS", env);
    const checks: LiveCheck[] = [];
    const found = await identities(client, env);
    const app = found.find((entry) => entry.variable === "CHANNELSTACK_SLACK_BOT_TOKEN");
    for (const entry of found) {
      const shown = `${entry.variable} (${entry.credential.prefix()}…)`;
      if (entry.problem) {
        checks.push({ ok: false, text: `${shown}: Slack refused it (${entry.problem})` });
        continue;
      }
      const who = entry.who;
      if (!who) continue;
      const isApp = entry === app;
      if (isApp !== who.bot) {
        checks.push({ ok: false, text: `${shown}: ${isApp ? "not a bot token (xoxb-)" : "a bot token, not a person's (xoxp-)"}` });
        continue;
      }
      if (!allowlist.allows(who.team)) {
        checks.push({ ok: false, text: `${shown}: workspace ${who.team} isn't in CHANNELSTACK_LIVE_SLACK_TEAMS` });
        continue;
      }
      if (!isApp && app?.who && app.who.team !== who.team) {
        checks.push({ ok: false, text: `${shown}: workspace ${who.team}, and the app is in ${app.who.team}` });
        continue;
      }
      checks.push({ ok: true, text: `${shown}: ${isApp ? "the app's bot" : "a person"} in workspace ${who.team}` });
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
      if (!allowlist.allows(entry.workspace)) continue;
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
