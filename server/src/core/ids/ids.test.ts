import { describe, expect, test } from "vitest";

import { ProtocolError } from "../errors/index.ts";
import { CHANNELSTACK_IDS, idFormats, IdGenerator, numeric, parseSeed, UPPER_ALNUM, uuid } from "./index.ts";

const fixedClock = () => 1_732_101_234_567;
const generator = (seed = 42) => new IdGenerator({ seed, clock: fixedClock });
/** Formats of a made-up platform: the generator works on any driver's. Each driver's own are tested in drivers/formats.test.ts. */
const TEST = idFormats("test", {
  user: {
    pattern: /^U0[0-9A-Z]{9}$/,
    accepts: /^U[0-9A-Z]{8,11}$/,
    generate: (draw) => `U0${draw.chars(9, UPPER_ALNUM)}`,
  },
  number: numeric(1_000, 9_999, /^\d{4}$/),
  uuid,
});
const formats = [...Object.values(TEST), ...Object.values(CHANNELSTACK_IDS)];

describe("the id generator", () => {
  test("a driver's formats are named after it", () => {
    expect(TEST.user.kind).toBe("test.user");
    expect(CHANNELSTACK_IDS.session.kind).toBe("channelstack.session");
  });

  test("sequential ids count per scope, like GitHub issue numbers and Linear identifiers", () => {
    const ids = generator();
    expect([ids.sequence("github.issue:1"), ids.sequence("github.issue:1"), ids.sequence("github.issue:2")]).toEqual([
      1, 2, 1,
    ]);
  });

  test("monotonic microseconds increase strictly and start at the clock's time", () => {
    const ids = generator();
    let last = 0;
    for (let i = 0; i < 10_000; i++) {
      const micros = ids.monotonicMicros();
      expect(micros).toBeGreaterThan(last);
      last = micros;
    }
    expect(Math.floor(last / 1_000_000)).toBeGreaterThanOrEqual(1_732_101_234);
  });

  test("the same seed gives the same ids, a different seed doesn't", () => {
    const draw = (seed: number) => {
      const ids = generator(seed);
      return [...formats.map((format) => ids.next(format)), ids.monotonicMicros(), ids.monotonicMicros()];
    };
    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(8));
  });

  test("exit check 12.5: an app's ids depend on the seed and its name, not on what was made before", () => {
    const appIds = (seed: number, before: number) => {
      const ids = generator(seed);
      for (let i = 0; i < before; i++) ids.next(TEST.user);
      const coder = ids.named("slack:coder");
      return [coder.next(TEST.user), coder.next(TEST.number)];
    };
    expect(appIds(7, 0)).toEqual(appIds(7, 25));
    expect(appIds(7, 0)).not.toEqual(appIds(8, 0));
    const ids = generator(7);
    expect(ids.named("slack:coder").next(TEST.user)).not.toBe(ids.named("slack:reviewer").next(TEST.user));
  });

  test("an app's ids are unique in the world with every other id", () => {
    const ids = generator(7);
    const first = ids.named("slack:coder").next(TEST.user);
    expect(() => ids.reserve(TEST.user, first)).toThrow(/already in use/);
  });

  test("CHANNELSTACK_SEED accepts a number or any text", () => {
    expect(parseSeed("42")).toBe(42);
    expect(parseSeed("release-candidate")).toBe(parseSeed("release-candidate"));
    expect(parseSeed("a")).not.toBe(parseSeed("b"));
    expect(Number.isInteger(parseSeed("1234567890123"))).toBe(true);
  });
});

describe("fixed ids", () => {
  test("an id in the platform's format is accepted once", () => {
    const ids = generator();
    expect(ids.reserve(TEST.user, "U0ADMIN01")).toBe("U0ADMIN01");
    expect(() => ids.reserve(TEST.user, "U0ADMIN01")).toThrow(/already in use/);
    ids.release(TEST.user, "U0ADMIN01");
    expect(ids.reserve(TEST.user, "U0ADMIN01")).toBe("U0ADMIN01");
  });

  test("an id in the wrong format is refused with invalid_argument, naming the kind", () => {
    const ids = generator();
    for (const [format, id] of [
      [TEST.user, "ana"],
      [TEST.user, "C08E1F2G3H4"],
      [TEST.number, "-1"],
      [TEST.uuid, "not-a-uuid"],
    ] as const) {
      expect(() => ids.reserve(format, id)).toThrow(ProtocolError);
    }
    expect(() => ids.reserve(TEST.user, "ana")).toThrow(/test\.user/);
  });

  test("a generated id never reuses a reserved one, and reset starts sequences over", () => {
    const ids = generator();
    const twin = generator();
    const taken = twin.next(TEST.user);
    ids.reserve(TEST.user, taken);
    expect(ids.next(TEST.user)).not.toBe(taken);

    ids.sequence("s");
    ids.reset();
    expect(ids.sequence("s")).toBe(1);
  });
});
