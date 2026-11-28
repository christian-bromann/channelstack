import { describe, expect, test } from "vitest";

import { testsOf } from "./tests-of.ts";

// What `pnpm check:unchanged` compares (exit check 12.1): every test of a file, with its modifiers.
describe("testsOf", () => {
  const source = `
import { describe, it, test } from "vitest";

test("plain", async () => {});
test.skipIf(!process.env.LIVE)("live only", async () => {});
test.concurrent("at once", async () => {});
test.for([1, 2])("copy %i", async (copy) => {});
test.concurrent.for([1, 2])("copy %i at once", { timeout: 1 }, async (copy) => {});
it("as it", () => {});
describe("a group", () => {
  test.skip("skipped", () => {});
  describe.skipIf(false)("an inner group", () => {
    test("deep", () => {});
  });
});
describe.for(["a", "b"])("each %s", (name) => {
  test.runIf(true)("in each", () => {});
});
helper("not a test", () => {});
`;
  const tests = testsOf(source, "example.test.ts");

  test("finds each test by its full name, whatever its modifiers and its group's", () => {
    expect([...tests.keys()]).toEqual([
      "plain",
      "live only",
      "at once",
      "copy %i",
      "copy %i at once",
      "as it",
      "a group > skipped",
      "a group > an inner group > deep",
      "each %s > in each",
    ]);
  });

  test("keeps each test's source with its modifiers, so a changed modifier or body is a change", () => {
    expect(tests.get("live only")).toBe('test.skipIf(!process.env.LIVE)("live only", async () => {})');
    const edited = testsOf(source.replace("test.skipIf(!process.env.LIVE)", "test"), "example.test.ts");
    expect(edited.get("live only")).not.toBe(tests.get("live only"));
  });
});
