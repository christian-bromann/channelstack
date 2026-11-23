import { ProtocolError } from "../errors/index.ts";

/** Where a driver's objects live: in the fake, or on the real platform. */
export type Reality = "fake" | "live";

/**
 * Whether an operation works live, declared on its route. Without a declaration it does, on a
 * driver that has a live backend.
 * - `unsupported`: no live counterpart, or not yet ("No" and "Not yet" in the reality matrix).
 * - `requires`: works live only with that piece, which the server doesn't have (the browser
 *   actor, proxy mode).
 */
export type LiveSupport =
  { readonly unsupported: string } | { readonly requires: "browser" | "proxy"; readonly reason: string };

/** The fake-only features every channel shares: delivery chaos. Live, the platform delivers to the agent itself. */
export const DELIVERY_IS_THE_PLATFORMS: LiveSupport = {
  unsupported:
    "Live, the platform delivers to the agent itself and channelstack isn't in the path (delivery chaos is fake-only)",
};

/** `CHANNELSTACK_REALITY`: `fake` keeps everything fake even with credentials; `live` refuses what would fall back to fake. */
export function forcedReality(env: Readonly<Record<string, string | undefined>>): Reality | undefined {
  const value = env.CHANNELSTACK_REALITY?.trim();
  if (value === undefined || value === "") return undefined;
  if (value === "fake" || value === "live") return value;
  throw new Error(`CHANNELSTACK_REALITY must be "fake" or "live", got "${value}"`);
}

/**
 * What one driver is in this server: fake; live (with the check that runs once before its first
 * live action: the app's credentials and allowlist); or wanted live without the credentials it needs.
 */
export type DriverReality =
  | { readonly mode: "fake" }
  | { readonly mode: "live"; ready(): Promise<void>; readonly hasBackend: boolean }
  | { readonly mode: "missing"; readonly missing: readonly string[] };

/** Decide a driver's reality from the credentials it declares and `CHANNELSTACK_REALITY`. */
export function driverReality(
  env: Readonly<Record<string, string | undefined>>,
  credentials: readonly string[],
  backend: { ready(): Promise<void> } | undefined,
): DriverReality {
  const forced = forcedReality(env);
  if (forced === "fake" || credentials.length === 0) return { mode: "fake" };
  const missing = credentials.filter((name) => !env[name]);
  if (missing.length === 0) {
    return backend
      ? { mode: "live", ready: () => backend.ready(), hasBackend: true }
      : { mode: "live", ready: async () => {}, hasBackend: false };
  }
  // Some credentials, not all: a typo in a variable name must not silently run fake.
  if (forced === "live" || missing.length < credentials.length) return { mode: "missing", missing };
  return { mode: "fake" };
}

export function unsupportedInLive(operation: string, reason: string): ProtocolError {
  return new ProtocolError("unsupported_in_live", `${operation} isn't supported live: ${reason}`, {
    operation,
    reason,
  });
}

export function actionRequires(operation: string, requires: string, reason: string): ProtocolError {
  return new ProtocolError("action_requires", `${operation} live needs ${requires}: ${reason}`, {
    operation,
    requires,
    reason,
  });
}

/** Live mode is set up wrong. Unlike `action_requires`, a test fails for it: a broken setup must not pass as skipped. */
export function liveMisconfigured(what: string, fix: string): ProtocolError {
  return new ProtocolError("live_misconfigured", `${what}: ${fix}`, { what, fix });
}

/** Refuse an operation the way its declaration says, on a driver of this reality. Nothing happens in the fake. */
export async function admitLive(
  reality: DriverReality,
  operation: string,
  support: LiveSupport | undefined,
  channel: string,
): Promise<void> {
  if (reality.mode === "fake") return;
  if (reality.mode === "missing") {
    throw liveMisconfigured(
      `${channel} has some of its live credentials and not all`,
      `set ${reality.missing.join(" and ")}, or unset the others to run it fake`,
    );
  }
  if (support && "unsupported" in support) throw unsupportedInLive(operation, support.unsupported);
  if (support && "requires" in support) {
    throw actionRequires(
      operation,
      support.requires === "browser" ? "the browser actor" : "proxy mode",
      support.reason,
    );
  }
  if (!reality.hasBackend) throw unsupportedInLive(operation, `live ${channel} isn't built yet`);
  await reality.ready();
}

/** A fake person acting in a live workspace: refused, in core, for every driver. */
export function fakeActorInLiveWorld(who: string, channel: string): ProtocolError {
  return new ProtocolError(
    "fake_actor_in_live_world",
    `${who} is a fake person and ${channel} is live: give them a token (CHANNELSTACK_${channel.toUpperCase()}_USER_<NAME>_TOKEN)`,
    { who },
  );
}
