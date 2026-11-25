import { liveMisconfigured } from "../../../core/reality/index.ts";
import type { Allowlist } from "../../../core/safety/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import type { ResendRestClient } from "./client.ts";

/** Who a Resend key is: its team's verified domains, and which of them receive email. */
export interface ResendIdentity {
  readonly domains: ReadonlyArray<{ readonly id: string; readonly name: string; readonly receiving: boolean }>;
}

interface WireDomains {
  data: Array<{ id: string; name: string; status: string; capabilities?: { sending?: string; receiving?: string } }>;
}

export async function identifyResend(client: ResendRestClient, credential: LiveCredential): Promise<ResendIdentity> {
  const { data } = await client.call<WireDomains>(credential, "GET", "/domains");
  return {
    domains: data
      .filter((domain) => domain.status === "verified")
      .map((domain) => ({ id: domain.id, name: domain.name, receiving: domain.capabilities?.receiving === "enabled" })),
  };
}

/**
 * The one check of a Resend key, for the live world and `channelstack doctor` alike: its team has a
 * verified domain that is allowlisted, and the address it sends from is on one. Throws the refusal.
 * Returns the domain the address is on.
 */
export function checkResendCredential(
  identity: ResendIdentity,
  expected: { who: string; allowlist: Allowlist; address?: string | undefined },
): string {
  const domain = expected.address?.slice(expected.address.lastIndexOf("@") + 1).toLowerCase();
  const found = domain === undefined ? identity.domains[0] : identity.domains.find((each) => each.name === domain);
  if (!found) {
    throw liveMisconfigured(
      domain === undefined
        ? `${expected.who}'s team has no verified domain`
        : `${expected.who}'s team hasn't verified ${domain}`,
      "verify a domain in Resend (Domains) that sends and receives, and allowlist it in CHANNELSTACK_LIVE_RESEND_DOMAINS",
    );
  }
  // People email the agent's address, and the agent's answers reach the people's: both domains receive.
  if (!found.receiving) {
    throw liveMisconfigured(
      `${expected.who}'s domain ${found.name} doesn't receive email`,
      "turn on Receiving for the domain in Resend (Domains), and add the MX record it shows",
    );
  }
  expected.allowlist.assert(found.name, `Resend domain ${found.name}`);
  return found.name;
}
