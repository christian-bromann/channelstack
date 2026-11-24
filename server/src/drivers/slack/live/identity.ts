import { ProtocolError } from "../../../core/errors/index.ts";
import { liveMisconfigured } from "../../../core/reality/index.ts";
import type { Allowlist } from "../../../core/safety/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import type { SlackWebClient } from "./client.ts";

/** Who a Slack token is, by `auth.test`. */
export interface SlackIdentity {
  readonly user: string;
  readonly team: string;
  readonly teamName: string;
  readonly url: string;
  /** Set for a bot token: the bot's id. */
  readonly botId: string | undefined;
  /** The token's scopes, from Slack's header. */
  readonly scopes: readonly string[];
}

export async function identify(client: SlackWebClient, credential: LiveCredential): Promise<SlackIdentity> {
  const answer = await client.call("auth.test", credential);
  return {
    user: String(answer.user_id),
    team: String(answer.team_id),
    teamName: String(answer.team ?? ""),
    url: String(answer.url ?? ""),
    botId: typeof answer.bot_id === "string" ? answer.bot_id : undefined,
    scopes: typeof answer.scopes === "string" ? answer.scopes.split(",") : [],
  };
}

/**
 * The one check of a Slack credential, for the live world and `channelstack doctor` alike. The
 * app's must be a bot token in an allowlisted workspace; a person's a user token in the app's
 * workspace. Throws the refusal: `live_misconfigured`, `cross_workspace_credential` or
 * `live_not_allowlisted`.
 *
 * It can't see which app issued a person's token: `auth.test` doesn't say. It doesn't matter for
 * what the token does live, since a person's messages are typed in the client (decision 0015).
 */
export function checkSlackCredential(
  identity: SlackIdentity,
  expected: { role: "app" | "person"; who: string; allowlist: Allowlist; appTeam?: string | undefined },
): void {
  if (expected.role === "app" && identity.botId === undefined) {
    throw liveMisconfigured(
      `${expected.who} isn't a bot token`,
      "the app acts with its bot token (xoxb-); a person's token can't act as the app",
    );
  }
  if (expected.role === "person" && identity.botId !== undefined) {
    throw liveMisconfigured(`${expected.who} is a bot token`, "a person acts with their own user token (xoxp-)");
  }
  if (expected.role === "person" && expected.appTeam !== undefined && identity.team !== expected.appTeam) {
    throw new ProtocolError(
      "cross_workspace_credential",
      `${expected.who} is for workspace ${identity.team}, and the app is in ${expected.appTeam}`,
      { team: identity.team },
    );
  }
  expected.allowlist.assert(identity.team, `Slack workspace ${identity.team}`);
}
