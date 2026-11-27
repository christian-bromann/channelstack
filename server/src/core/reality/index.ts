import { LivePlatformRefusal, ProtocolError } from "../errors/index.ts";

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

/**
 * A real account's roles are the platform's: a test that asks for another one would pass or fail
 * for the wrong reason (an agent that lets only admins approve refuses a member's click). Refuses
 * the first role the test asks for that the account doesn't have, or has and the test says it hasn't.
 */
export function checkRoles(
  person: string,
  roles: ReadonlyArray<{ option: string; wanted: boolean | undefined; has: boolean; role: string }>,
): void {
  for (const { option, wanted, has, role } of roles) {
    if (wanted === undefined || wanted === has) continue;
    throw liveMisconfigured(
      `${person}'s account is ${has ? "" : "not "}${role}, but the test asks for ${option}: ${wanted}`,
      `make the account ${wanted ? "" : "no longer "}${role} in the sandbox workspace, or change the test`,
    );
  }
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
      support.requires === "proxy"
        ? // Proxy mode exists, but live it records the agent's calls as shapes only (issue #24).
          `${support.reason}; live, \`start --proxy\` doesn't read the agent's calls back yet`
        : support.reason,
    );
  }
  if (!reality.hasBackend) throw unsupportedInLive(operation, `live ${channel} isn't built yet`);
  await reality.ready();
}

/**
 * A live world's check of its credentials (who the token is, the allowlist), made once for the
 * server: a definitive answer is kept, so every later action is refused the same way without
 * asking the platform again. A failure that will pass isn't: a network error, or a refusal
 * `passing` says will pass (by default the platform's own failure or a rate limit, a 5xx or 429).
 * The next action asks again.
 */
export function checkOnce(
  check: () => Promise<void>,
  passing: (error: ProtocolError) => boolean = (error) =>
    error instanceof LivePlatformRefusal &&
    error.httpStatus !== undefined &&
    (error.httpStatus >= 500 || error.httpStatus === 429),
): () => Promise<void> {
  let checked: Promise<void> | undefined;
  return () =>
    (checked ??= check().catch((error: unknown) => {
      if (!(error instanceof ProtocolError) || passing(error)) checked = undefined;
      throw error;
    }));
}

/**
 * With `CHANNELSTACK_REALITY=live`, a person a test makes without a credential is refused, not
 * made a fake person: a strict live run must not act as nobody. `lacks` is what they have no
 * (`a token`), `variable` names the variable's person part (`<NAME>`, GitHub's `<LOGIN>`), and
 * `as` says what goes in it, where that isn't plain.
 */
export function personWithoutToken(
  who: string,
  channel: string,
  options: { lacks?: string; variable?: string; as?: string } = {},
): ProtocolError {
  const variable = `CHANNELSTACK_${channel.toUpperCase()}_USER_${options.variable ?? "<NAME>"}_TOKEN`;
  return liveMisconfigured(
    `CHANNELSTACK_REALITY is live and ${who} has no ${options.lacks ?? "token"}`,
    `set ${variable} for them${options.as ? ` to ${options.as}` : ""}, or run without CHANNELSTACK_REALITY=live`,
  );
}

/** A fake person acting in a live workspace: refused, in core, for every driver. */
export function fakeActorInLiveWorld(who: string, channel: string): ProtocolError {
  return new ProtocolError(
    "fake_actor_in_live_world",
    `${who} is a fake person and ${channel} is live: give them a token (CHANNELSTACK_${channel.toUpperCase()}_USER_<NAME>_TOKEN)`,
    { who },
  );
}
