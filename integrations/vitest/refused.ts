import { ChannelstackError, type Session } from "../../sdks/typescript/client.ts";

/** The refusals live mode skips a test for (setup.ts): what it can't do, or needs a piece this run lacks. */
export const SKIPS_LIVE: ReadonlySet<string> = new Set(["unsupported_in_live", "action_requires"]);

/** A test context with the test's session, as the integration's own fixture holds it. */
export type WithSession = { channelstackSession?: Session | undefined };

/** Sessions whose refused requests don't skip their test right now: the caller handles the refusal. */
export const unskipped = new Set<string>();

/**
 * Run a read that may be refused live, without skipping the test for it: for channelstack's own
 * per-test checks of what the fake sends (its calls, its webhooks), which a live channel has none
 * of. Resolves with nothing when the read is refused live.
 */
export async function withoutLiveSkips<T>(context: WithSession, read: () => Promise<T>): Promise<T | undefined> {
  const session = context.channelstackSession;
  if (session) unskipped.add(session.sessionId);
  try {
    return await read();
  } catch (error) {
    if (error instanceof ChannelstackError && SKIPS_LIVE.has(error.code)) return undefined;
    throw error;
  } finally {
    if (session) unskipped.delete(session.sessionId);
  }
}

/** What a channel's fixture answers when it was refused live: the stand-in says so without throwing. */
const REFUSED = Symbol.for("channelstack.refusedLive");

/** A stand-in for a channel's fixture that was refused live: any use of it throws `refuse()`. */
export function refusedFixture(refuse: () => never): object {
  return new Proxy(
    {},
    {
      get: (_, property) => {
        if (property === REFUSED) return true;
        // `then` is looked up when a value is awaited: the stand-in isn't a promise.
        if (property === "then") return undefined;
        return refuse();
      },
    },
  );
}

/**
 * Was this channel refused live (its live backend isn't built, or its credentials are set in part)?
 * For channelstack's own per-test checks of what the fake sends, which a refused channel has none of.
 */
export function refusedLive(fixture: unknown): boolean {
  return typeof fixture === "object" && fixture !== null && (fixture as Record<symbol, unknown>)[REFUSED] === true;
}
