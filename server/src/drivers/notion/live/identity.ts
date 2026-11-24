import { ProtocolError } from "../../../core/errors/index.ts";
import { liveMisconfigured } from "../../../core/reality/index.ts";
import type { Allowlist } from "../../../core/safety/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import type { NotionRestClient } from "./client.ts";

/**
 * Who a Notion credential is, by `users/me`. Every token answers as a bot: the integration's is
 * owned by the workspace, and a personal access token's by the person it acts as.
 */
export interface NotionIdentity {
  /** The token's own bot user. */
  readonly bot: string;
  readonly name: string;
  readonly workspace: { readonly id: string; readonly name: string };
  /** The person a personal access token acts as; none for an integration's token. */
  readonly person: string | undefined;
}

interface WireMe {
  id: string;
  name: string | null;
  type: "bot" | "person";
  bot?: {
    owner?: { type: "workspace" | "user"; user?: { id: string } };
    workspace_id?: string;
    workspace_name?: string;
  };
}

export async function identifyNotion(client: NotionRestClient, credential: LiveCredential): Promise<NotionIdentity> {
  const me = await client.call<WireMe>(credential, "get", "users/me");
  return {
    bot: me.id,
    name: me.name ?? "",
    workspace: { id: me.bot?.workspace_id ?? "", name: me.bot?.workspace_name ?? "" },
    person: me.bot?.owner?.type === "user" ? me.bot.owner.user?.id : undefined,
  };
}

/**
 * The one check of a Notion credential, for the live world and `channelstack doctor` alike. The
 * integration's must be an integration's (owned by the workspace) in an allowlisted workspace; a
 * person's must act as a person, in the integration's workspace. Throws the refusal.
 */
export function checkNotionCredential(
  identity: NotionIdentity,
  expected: { role: "app" | "person"; who: string; allowlist: Allowlist; appWorkspace?: string | undefined },
): void {
  if (expected.role === "app" && identity.person !== undefined) {
    throw liveMisconfigured(
      `${expected.who} acts as a person`,
      "use the agent's integration token (ntn_…); a person's token can't act as the integration",
    );
  }
  if (expected.role === "person" && identity.person === undefined) {
    throw liveMisconfigured(
      `${expected.who} acts as an integration, not a person`,
      "a person acts with their own personal access token",
    );
  }
  if (
    expected.role === "person" &&
    expected.appWorkspace !== undefined &&
    identity.workspace.id !== expected.appWorkspace
  ) {
    throw new ProtocolError(
      "cross_workspace_credential",
      `${expected.who} is for workspace ${identity.workspace.id}, and the integration is in ${expected.appWorkspace}`,
      { workspace: identity.workspace.id },
    );
  }
  expected.allowlist.assert(identity.workspace.id, `Notion workspace ${identity.workspace.id}`);
}
