import {
  DIGITS,
  HEX,
  idFormats,
  type IdGenerator,
  type IdShape,
  LOWER_ALNUM,
  UPPER_ALNUM,
  uuid,
} from "../../core/ids/index.ts";

/** Slack ids: a type prefix, then base-36 characters. Current ids are 11 long and start `<prefix>0`; older ones are 9. */
function slack(prefix: string, accepts = prefix): IdShape {
  return {
    pattern: new RegExp(`^${prefix}0[0-9A-Z]{9}$`),
    accepts: new RegExp(`^(?:${accepts})[0-9A-Z]{8,11}$`),
    generate: (draw) => `${prefix}0${draw.chars(9, UPPER_ALNUM)}`,
  };
}

/**
 * Every id the Slack fake generates, in the platform's own format (architecture.md 3.2).
 */
export const SLACK_IDS = idFormats("slack", {
  team: slack("T"),
  user: slack("U", "U|W"),
  bot: slack("B"),
  app: slack("A"),
  channel: slack("C", "C|G"),
  dm: slack("D"),
  // Group DMs: Slack's docs show `G…`; the differential run (phase 6) confirms what current workspaces return.
  mpim: slack("G", "G|C"),
  event: slack("Ev"),
  view: slack("V"),
  file: slack("F"),
  envelope: uuid,
  // Block ids in a message a person typed: a few base-62 characters, as Slack's clients generate.
  block: {
    pattern: /^[A-Za-z0-9]{5}$/,
    generate: (draw) => draw.chars(5, `${UPPER_ALNUM}${LOWER_ALNUM.slice(10)}`),
  },
  trigger: {
    pattern: /^\d{13}\.\d{13}\.[0-9a-f]{32}$/,
    accepts: /^\d{9,13}\.\d{9,13}\.[0-9a-f]{32}$/,
    generate: (draw) => `${draw.chars(13, DIGITS)}.${draw.chars(13, DIGITS)}.${draw.chars(32, HEX)}`,
  },
});

export const SLACK_TS_PATTERN = /^\d{10}\.\d{6}$/;

/**
 * A Slack message `ts`: epoch seconds and microseconds. Strictly increasing across the world, so
 * a `ts` is unique in its conversation and orders messages the way they were written.
 */
export function slackTs(ids: IdGenerator): string {
  const micros = ids.monotonicMicros();
  return `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, "0")}`;
}

/** When a Slack `ts` was issued, as an ISO time: a `ts` is seconds since the epoch, then a counter. */
export function slackTsTime(ts: string): string {
  return new Date(Number(ts.split(".")[0]) * 1000).toISOString();
}
