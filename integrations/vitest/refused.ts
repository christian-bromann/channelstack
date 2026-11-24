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
