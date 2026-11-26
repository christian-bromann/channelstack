import { describe, expect, test } from "vitest";

import { changelogSection, pep440, problems, versions } from "./release.ts";

describe("one version for every package", () => {
  test("PyPI spells a prerelease its own way, and anything but X.Y.Z(-pre.N) is refused", () => {
    expect(pep440("0.1.0")).toBe("0.1.0");
    expect(pep440("1.2.3-alpha.1")).toBe("1.2.3a1");
    expect(pep440("1.2.3-beta.2")).toBe("1.2.3b2");
    expect(pep440("1.2.3-rc.10")).toBe("1.2.3rc10");
    for (const wrong of ["1.2", "v1.2.3", "1.2.3-dev.1", "1.2.3-rc1"]) expect(() => pep440(wrong)).toThrow();
  });

  test("a version's changelog section is what follows its heading, up to the next", () => {
    const changelog =
      "# Changelog\n\n## Unreleased\n\n## [0.2.0] - 2026-12-01\n\n- Two.\n\n## [0.1.0] - 2026-11-30\n\n- One.\n";
    expect(changelogSection(changelog, "0.2.0")).toBe("- Two.");
    expect(changelogSection(changelog, "0.1.0")).toBe("- One.");
    expect(changelogSection(changelog, "0.1")).toBeUndefined();
    expect(changelogSection(changelog, "0.3.0")).toBeUndefined();
  });

  test("the repository agrees with itself, and not with a tag of another version", () => {
    expect(problems()).toEqual([]);
    const version = versions()["sdks/typescript/package.json"];
    const other = problems({ tag: "v99.0.0" });
    expect(other).toContain(`sdks/typescript/package.json is ${version}, not 99.0.0`);
    expect(other).toContain('CHANGELOG.md has no "## [99.0.0]" section');
    expect(problems({ tag: "latest" })).toContain("the tag latest isn't vX.Y.Z or vX.Y.Z-(alpha|beta|rc).N");
  });
});
