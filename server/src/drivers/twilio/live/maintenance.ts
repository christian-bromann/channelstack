import { credentialChecks, liveCredentials, sweepLedger } from "../../../core/maintenance/index.ts";
import type { LiveMaintenance } from "../../../core/router/index.ts";
import { Allowlist } from "../../../core/safety/index.ts";
import { LiveCredential } from "../../../core/secrets/index.ts";
import { TwilioRefusal, TwilioRestClient } from "./client.ts";
import { checkTwilioCredential, identifyTwilio } from "./identity.ts";

const ALLOWLIST = "CHANNELSTACK_LIVE_TWILIO_NUMBERS";

type Env = Readonly<Record<string, string | undefined>>;

/** The agent's credential, `<Account SID>:<Auth Token>`, from its two variables; a person's is that already. */
const asAccount = (env: Env, credential: LiveCredential) =>
  credential.owner === "app"
    ? new LiveCredential("app", `${env.CHANNELSTACK_TWILIO_ACCOUNT_SID ?? ""}:${credential.reveal()}`)
    : credential;

/** The agent's account and every person's in the environment, each with its numbers, or why Twilio refused it. */
const credentials = (client: TwilioRestClient, env: Env) =>
  liveCredentials(env, {
    channel: "twilio",
    own: [{ variable: "CHANNELSTACK_TWILIO_AUTH_TOKEN", owner: "app" }],
    identify: (credential) => identifyTwilio(client, asAccount(env, credential)),
  });

/** A person's number from the environment, if it says: `CHANNELSTACK_TWILIO_USER_<NAME>_NUMBER`. */
const numberOf = (env: Env, owner: string) =>
  owner === "app"
    ? env.CHANNELSTACK_TWILIO_NUMBER
    : env[`CHANNELSTACK_TWILIO_USER_${owner.slice("user:".length)}_NUMBER`];

/**
 * `channelstack doctor` and `channelstack sweep` for Twilio, from the credentials in the
 * environment. Texts carry no tag a sweep could find them by, so the sweep is the ledger's: each
 * message a crashed run saw is deleted with the credential of the account it is on.
 */
export const twilioMaintenance: LiveMaintenance = {
  async doctor({ env, fetch, apiBase }) {
    const client = new TwilioRestClient({ base: apiBase, fetch });
    const allowlist = new Allowlist(ALLOWLIST, env);
    return credentialChecks(await credentials(client, env), ({ variable, credential, who }) => {
      const number = checkTwilioCredential(who, {
        who: variable,
        allowlist,
        number: numberOf(env, credential.owner),
        besides: env.CHANNELSTACK_TWILIO_NUMBER,
      });
      return `${credential.owner === "app" ? "the agent's number" : "a person's number"}, ${number}`;
    });
  },

  async sweep({ env, fetch, apiBase, entries, check }) {
    const client = new TwilioRestClient({ base: apiBase, fetch });
    const allowlist = new Allowlist(ALLOWLIST, env);
    const found = await credentials(client, env);
    const byOwner = (owner: string) => found.find(({ credential }) => credential.owner === owner)?.credential;
    return sweepLedger(entries, {
      allowlist,
      check,
      describe: (entry) => `message ${entry.ref.sid ?? ""}`,
      remove: async (entry) => {
        const credential = byOwner(entry.by);
        if (!credential) throw new Error(`no credential for ${entry.by} in the environment`);
        await deleteMessage(client, asAccount(env, credential), entry.ref.sid ?? "");
      },
    });
  },
};

/** Delete a message: one already gone is fine, since a session's cleanup or a sweep may have been first. */
export async function deleteMessage(client: TwilioRestClient, credential: LiveCredential, sid: string): Promise<void> {
  try {
    await client.call(credential, "DELETE", `/Messages/${sid}.json`);
  } catch (error) {
    if (error instanceof TwilioRefusal && error.code === "20404") return;
    throw error;
  }
}
