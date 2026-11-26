/** Draws from the world's seeded random source. */
export interface Draw {
  /** An integer in `[min, max]`. */
  int(min: number, max: number): number;
  /** `length` characters from `alphabet`. */
  chars(length: number, alphabet: string): string;
}

/** What one kind of id looks like, and how to make one. */
export interface IdShape {
  /** What a generated id looks like. Exit check 0.5 holds every generated id to this. */
  readonly pattern: RegExp;
  /** What the real platform's ids look like, for ids a test fixes itself. Defaults to `pattern`. */
  readonly accepts?: RegExp;
  generate(draw: Draw): string;
}

/** An id shape with its name (`slack.user`): what errors say, and what keeps its ids apart from other kinds'. */
export interface IdFormat extends IdShape {
  readonly kind: string;
}

export const DIGITS = "0123456789";
export const HEX = "0123456789abcdef";
export const UPPER_ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const LOWER_ALNUM = UPPER_ALNUM.toLowerCase();

/** Numeric ids in the range the platform currently hands out. */
export function numeric(min: number, max: number, pattern: RegExp): IdShape {
  return { pattern, accepts: /^[1-9]\d{0,15}$/, generate: (draw) => String(draw.int(min, max)) };
}

export const uuid: IdShape = {
  pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  generate: (draw) => {
    const h = draw.chars(30, HEX);
    const variant = "89ab"[draw.int(0, 3)];
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(12, 15)}-${variant}${h.slice(15, 18)}-${h.slice(18, 30)}`;
  },
};

/**
 * A driver's id formats, in the platform's own format (architecture.md 3.2), each named
 * `<driver>.<key>`. Every driver declares its own; core holds none of a platform's.
 */
export function idFormats<const T extends Record<string, IdShape>>(
  driver: string,
  shapes: T,
): { readonly [K in keyof T]: T[K] & { readonly kind: string } } {
  return Object.fromEntries(
    Object.entries(shapes).map(([key, shape]) => [key, { ...shape, kind: `${driver}.${key}` }]),
  ) as { readonly [K in keyof T]: T[K] & { readonly kind: string } };
}

/** channelstack's own ids. */
export const CHANNELSTACK_IDS = idFormats("channelstack", {
  /** The only id that is channelstack's own: no platform has sessions. */
  session: {
    pattern: /^ses_[0-9a-z]{20}$/,
    generate: (draw) => `ses_${draw.chars(20, LOWER_ALNUM)}`,
  },
});
