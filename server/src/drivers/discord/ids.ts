import { idFormats, type IdGenerator, type IdShape } from "../../core/ids/index.ts";

/** Discord's epoch: the first second of 2015, in milliseconds. A snowflake counts from it. */
const DISCORD_EPOCH = 1_420_070_400_000n;
/** What a snowflake looks like: a 64-bit number in decimal, 17 to 20 digits for anything made since 2016. */
const SNOWFLAKE = /^[1-9]\d{16,19}$/;

/** A snowflake from a time and the low 22 bits (worker, process, increment). */
const snowflakeAt = (ms: bigint, low: bigint) => (((ms - DISCORD_EPOCH) << 22n) | low).toString();

/**
 * A snowflake made at a random time between 2016 and 2025: what people, guilds and apps that
 * existed before a test have. Anything made during a test is `discordSnowflake`, at the time it is made.
 */
const pastSnowflake: IdShape = {
  pattern: SNOWFLAKE,
  generate: (draw) => {
    const ms = 1_451_606_400_000n + BigInt(draw.int(0, 315_360_000)) * 1000n + BigInt(draw.int(0, 999));
    return snowflakeAt(ms, BigInt(draw.int(0, 4_194_303)));
  },
};

/**
 * Every id the Discord fake draws, in Discord's own format (architecture.md 3.2): snowflakes, and
 * the Gateway's session ids.
 */
export const DISCORD_IDS = idFormats("discord", {
  user: pastSnowflake,
  guild: pastSnowflake,
  role: pastSnowflake,
  // A Gateway session: 32 hex characters.
  session: { pattern: /^[0-9a-f]{32}$/, generate: (draw) => draw.chars(32, "0123456789abcdef") },
});

/**
 * A snowflake for something made now: the time in its high bits, so it sorts the way things were
 * made, and unique across the world because the micros it is made of only grow.
 */
export function discordSnowflake(ids: IdGenerator): string {
  const micros = BigInt(ids.monotonicMicros());
  return snowflakeAt(micros / 1000n, micros % 1000n);
}

/** When a snowflake was made, as an ISO time. */
export function snowflakeTime(id: string): string {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH)).toISOString();
}
