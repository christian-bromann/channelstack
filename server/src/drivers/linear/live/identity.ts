import { ProtocolError } from "../../../core/errors/index.ts";
import { liveMisconfigured } from "../../../core/reality/index.ts";
import type { Allowlist } from "../../../core/safety/index.ts";
import type { LiveCredential } from "../../../core/secrets/index.ts";
import type { LinearGraphqlClient } from "./client.ts";

/** Who a Linear credential is, by `viewer` and its workspace. */
export interface LinearIdentity {
  readonly user: string;
  readonly name: string;
  readonly displayName: string;
  readonly admin: boolean;
  readonly guest: boolean;
  /** The token acts as an app (an OAuth token with `actor=app`). */
  readonly app: boolean;
  readonly org: { readonly id: string; readonly name: string; readonly urlKey: string };
}

const VIEWER = /* GraphQL */ `
  query Viewer {
    viewer {
      id
      name
      displayName
      admin
      guest
      app
    }
    organization {
      id
      name
      urlKey
    }
  }
`;

export async function identifyLinear(client: LinearGraphqlClient, credential: LiveCredential): Promise<LinearIdentity> {
  const answer = await client.call<{
    viewer: { id: string; name: string; displayName: string; admin: boolean; guest: boolean; app: boolean };
    organization: { id: string; name: string; urlKey: string };
  }>(credential, VIEWER);
  return { user: answer.viewer.id, ...answer.viewer, org: answer.organization };
}

/**
 * The one check of a Linear credential, for the live world and `channelstack doctor` alike. The
 * app's must act as the app in an allowlisted workspace; a person's must be a person's key in the
 * app's workspace. Throws the refusal.
 */
export function checkLinearCredential(
  identity: LinearIdentity,
  expected: { role: "app" | "person"; who: string; allowlist: Allowlist; appOrg?: string | undefined },
): void {
  if (expected.role === "app" && !identity.app) {
    throw liveMisconfigured(
      `${expected.who} doesn't act as an app`,
      "use the agent app's OAuth token (installed with actor=app); a person's key can't act as the app",
    );
  }
  if (expected.role === "person" && identity.app) {
    throw liveMisconfigured(`${expected.who} acts as an app`, "a person acts with their own personal API key");
  }
  if (expected.role === "person" && expected.appOrg !== undefined && identity.org.id !== expected.appOrg) {
    throw new ProtocolError(
      "cross_workspace_credential",
      `${expected.who} is for workspace ${identity.org.id}, and the app is in ${expected.appOrg}`,
      { workspace: identity.org.id },
    );
  }
  expected.allowlist.assert(identity.org.id, `Linear workspace ${identity.org.id}`);
}
