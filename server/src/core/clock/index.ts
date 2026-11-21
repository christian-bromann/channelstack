/** Milliseconds since the epoch. Injected wherever time ends up in an id, a signature or a log entry. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();
