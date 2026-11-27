import { liveMisconfigured } from "../../../core/reality/index.ts";
import type { Allowlist } from "../../../core/safety/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import { accountOf, type TwilioRestClient } from "./client.ts";

/** Who a credential is: its account, and the account's numbers that can send and receive texts. */
export interface TwilioIdentity {
  readonly accountSid: string;
  readonly numbers: readonly string[];
}

export async function identifyTwilio(client: TwilioRestClient, credential: LiveCredential): Promise<TwilioIdentity> {
  await client.call<{ sid: string }>(credential, "GET", "");
  const { incoming_phone_numbers: numbers = [] } = await client.call<{
    incoming_phone_numbers?: Array<{ phone_number: string; capabilities?: { sms?: boolean } }>;
  }>(credential, "GET", "/IncomingPhoneNumbers.json?PageSize=1000");
  return {
    accountSid: accountOf(credential),
    numbers: numbers.filter((number) => number.capabilities?.sms !== false).map((number) => number.phone_number),
  };
}

/**
 * The one check of a Twilio credential and its number, for the live world and `channelstack doctor`
 * alike: the number is the account's, and in the allowlist, since a text to or from it can't be
 * taken back and costs money. Without a number, the account's one allowlisted number besides
 * `besides` (the agent's). Throws the refusal; returns the number.
 */
export function checkTwilioCredential(
  identity: TwilioIdentity,
  expected: { who: string; allowlist: Allowlist; number?: string | undefined; besides?: string | undefined },
): string {
  const { who, allowlist } = expected;
  if (expected.number !== undefined) {
    if (!identity.numbers.includes(expected.number)) {
      throw liveMisconfigured(
        `${expected.number} isn't a number of ${who}'s account ${identity.accountSid}`,
        "give the number of the account the token opens",
      );
    }
    allowlist.assert(expected.number, `${who}'s number ${expected.number}`);
    return expected.number;
  }
  const candidates = identity.numbers.filter((number) => number !== expected.besides && allowlist.allows(number));
  if (candidates.length !== 1) {
    throw liveMisconfigured(
      `${who}'s account ${identity.accountSid} has ${candidates.length} numbers in ${allowlist.variable} besides the agent's`,
      "say which is theirs (`number`, or CHANNELSTACK_TWILIO_USER_<NAME>_NUMBER)",
    );
  }
  return candidates[0] as string;
}
