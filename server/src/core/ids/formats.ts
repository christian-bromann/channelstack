/** Draws from the world's seeded random source. */
export interface Draw {
  /** An integer in `[min, max]`. */
  int(min: number, max: number): number;
  /** `length` characters from `alphabet`. */
  chars(length: number, alphabet: string): string;
}

interface IdFormat {
  /** What a generated id looks like. Exit check 0.5 holds every generated id to this. */
  readonly pattern: RegExp;
  /** What the real platform's ids look like, for ids a test fixes itself. Defaults to `pattern`. */
  readonly accepts?: RegExp;
  generate(draw: Draw): string;
}

const DIGITS = "0123456789";
const HEX = "0123456789abcdef";
const UPPER_ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER_ALNUM = UPPER_ALNUM.toLowerCase();

/** Slack ids: a type prefix, then base-36 characters. Current ids are 11 long and start `<prefix>0`; older ones are 9. */
function slack(prefix: string, accepts = prefix): IdFormat {
  return {
    pattern: new RegExp(`^${prefix}0[0-9A-Z]{9}$`),
    accepts: new RegExp(`^(?:${accepts})[0-9A-Z]{8,11}$`),
    generate: (draw) => `${prefix}0${draw.chars(9, UPPER_ALNUM)}`,
  };
}

/** Numeric ids in the range the platform currently hands out. */
function numeric(min: number, max: number, pattern: RegExp): IdFormat {
  return { pattern, accepts: /^[1-9]\d{0,15}$/, generate: (draw) => String(draw.int(min, max)) };
}

/** An echo id: the echo platform is channelstack's own, so this format is ours. */
function echo(prefix: string): IdFormat {
  return { pattern: new RegExp(`^${prefix}[0-9A-Z]{10}$`), generate: (draw) => `${prefix}${draw.chars(10, UPPER_ALNUM)}` };
}

const uuid: IdFormat = {
  pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  generate: (draw) => {
    const h = draw.chars(30, HEX);
    const variant = "89ab"[draw.int(0, 3)];
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(12, 15)}-${variant}${h.slice(15, 18)}-${h.slice(18, 30)}`;
  },
};

/**
 * Every id channelstack generates, in the platform's own format (architecture.md 3.2).
 * Sequential ids (GitHub issue numbers, Linear identifiers, Slack `ts`) are methods on `IdGenerator`.
 */
export const ID_FORMATS = {
  "slack.team": slack("T"),
  "slack.user": slack("U", "U|W"),
  "slack.bot": slack("B"),
  "slack.app": slack("A"),
  "slack.channel": slack("C", "C|G"),
  "slack.dm": slack("D"),
  // Group DMs: Slack's docs show `G…`; the differential run (phase 6) confirms what current workspaces return.
  "slack.mpim": slack("G", "G|C"),
  "slack.event": slack("Ev"),
  "slack.view": slack("V"),
  "slack.file": slack("F"),
  "slack.trigger": {
    pattern: /^\d{13}\.\d{13}\.[0-9a-f]{32}$/,
    accepts: /^\d{9,13}\.\d{9,13}\.[0-9a-f]{32}$/,
    generate: (draw) => `${draw.chars(13, DIGITS)}.${draw.chars(13, DIGITS)}.${draw.chars(32, HEX)}`,
  },
  "github.user": numeric(100_000_000, 299_999_999, /^[12]\d{8}$/),
  "github.repo": numeric(1_000_000_000, 1_199_999_999, /^1[01]\d{8}$/),
  "github.app": numeric(1_000_000, 2_999_999, /^[12]\d{6}$/),
  "github.installation": numeric(60_000_000, 99_999_999, /^[6-9]\d{7}$/),
  "github.issue": numeric(3_000_000_000, 3_999_999_999, /^3\d{9}$/),
  "github.comment": numeric(3_000_000_000, 3_999_999_999, /^3\d{9}$/),
  "github.review": numeric(3_000_000_000, 3_999_999_999, /^3\d{9}$/),
  "github.checkRun": numeric(50_000_000_000, 59_999_999_999, /^5\d{10}$/),
  "github.delivery": uuid,
  "linear.uuid": uuid,
  "notion.uuid": uuid,
  "echo.app": echo("EA"),
  "echo.user": echo("EU"),
  "echo.room": echo("ER"),
  "echo.message": echo("EM"),
  "echo.delivery": echo("ED"),
  /** The only id that is channelstack's own: no platform has sessions. */
  "channelstack.session": {
    pattern: /^ses_[0-9a-z]{20}$/,
    generate: (draw) => `ses_${draw.chars(20, LOWER_ALNUM)}`,
  },
} as const satisfies Record<string, IdFormat>;

export type IdKind = keyof typeof ID_FORMATS;

export const SLACK_TS_PATTERN = /^\d{10}\.\d{6}$/;
