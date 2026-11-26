import type { Allowlist } from "../../../core/safety/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import type { GoogleRestClient } from "./client.ts";

/** Who a refresh token is: the Gmail address of its mailbox. */
export interface GoogleIdentity {
  readonly address: string;
}

export async function identifyGoogle(client: GoogleRestClient, credential: LiveCredential): Promise<GoogleIdentity> {
  const { emailAddress } = await client.call<{ emailAddress: string }>(credential, "GET", "gmail/v1/users/me/profile");
  return { address: emailAddress.toLowerCase() };
}

/**
 * The one check of a Google mailbox, for the live world and `channelstack doctor` alike: its address
 * is in the allowlist, since mail sent to or from it can't be taken back. Throws the refusal;
 * returns the address.
 */
export function checkGoogleCredential(
  identity: GoogleIdentity,
  expected: { who: string; allowlist: Allowlist },
): string {
  expected.allowlist.assert(identity.address, `${expected.who}'s mailbox ${identity.address}`);
  return identity.address;
}
