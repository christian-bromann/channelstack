import { credentialChecks, liveCredentials, sweepLedger } from "../../../core/maintenance/index.ts";
import type { LiveMaintenance } from "../../../core/router/index.ts";
import { Allowlist } from "../../../core/safety/index.ts";
import { ResendRestClient } from "./client.ts";
import { checkResendCredential, identifyResend } from "./identity.ts";

const ALLOWLIST = "CHANNELSTACK_LIVE_RESEND_DOMAINS";

/**
 * `channelstack doctor` and `channelstack sweep` for Resend. Email that was sent can't be taken
 * back, so a run leaves nothing to remove: the sweep only clears the ledger, and live mode refuses
 * an address outside the allowlisted domains before anything is sent.
 */
export const resendMaintenance: LiveMaintenance = {
  async doctor({ env, fetch, apiBase }) {
    const client = new ResendRestClient({ base: apiBase, fetch });
    const allowlist = new Allowlist(ALLOWLIST, env);
    const found = await liveCredentials(env, {
      channel: "resend",
      own: [{ variable: "CHANNELSTACK_RESEND_API_KEY", owner: "app" }],
      identify: (credential) => identifyResend(client, credential),
    });
    return credentialChecks(found, ({ variable, credential, who }) => {
      const address = credential.owner === "app" ? env.CHANNELSTACK_RESEND_ADDRESS : undefined;
      const domain = checkResendCredential(who, { who: variable, allowlist, address });
      return `${credential.owner === "app" ? "the agent's team" : "a person's team"}, at ${domain}`;
    });
  },

  sweep: ({ env, entries, check }) =>
    sweepLedger(entries, {
      allowlist: new Allowlist(ALLOWLIST, env),
      check,
      describe: (entry) => `email ${entry.ref.name ?? ""}`,
      // Nothing a run sends can be removed: Resend has no way to unsend.
      remove: async () => {},
    }),
};
