import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { changelogSection, draft, lastTag, nextVersion, pep440, problems, released, versions } from "./release.ts";

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

describe("the changelog draft, from the pull requests' titles", () => {
  const repositories: string[] = [];
  afterEach(() => {
    for (const repository of repositories.splice(0)) rmSync(repository, { recursive: true, force: true });
  });

  /** A repository with a commit for each title, and the tag `v0.1.0` after the first `tagAfter`. */
  function repository(titles: readonly string[], tagAfter?: number): string {
    const dir = mkdtempSync(join(tmpdir(), "channelstack-release-"));
    repositories.push(dir);
    const git = (...args: string[]) => {
      const result = spawnSync(
        "git",
        [
          "-c",
          "user.name=Ana",
          "-c",
          "user.email=ana@example.com",
          "-c",
          "commit.gpgSign=false",
          "-c",
          "tag.gpgSign=false",
          ...args,
        ],
        { cwd: dir, encoding: "utf8" },
      );
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    };
    git("init", "-q", "-b", "main");
    titles.forEach((title, index) => {
      git("commit", "-q", "--allow-empty", "-m", title, "-m", "* a commit of the pull request");
      if (index + 1 === tagAfter) git("tag", "v0.1.0");
    });
    return dir;
  }

  test("nothing is drafted or bumped before the first tag", () => {
    const dir = repository(["Phase 9: Google (Gmail) (#88)", "feat(slack): files (#96)"]);
    expect(lastTag(dir)).toBeUndefined();
    expect(draft(dir)).toBe("");
    expect(() => nextVersion(dir)).toThrow("There's no v* tag to bump yet");
  });

  test("a shallow clone, which has neither the history nor the tags, is refused", () => {
    const dir = repository(["Phase 9: Google (Gmail) (#88)", "feat(slack): files (#96)", "fix(slack): more (#97)"], 1);
    const shallow = mkdtempSync(join(tmpdir(), "channelstack-release-"));
    repositories.push(shallow);
    const cloned = spawnSync("git", ["clone", "-q", "--depth", "1", `file://${dir}`, shallow], { encoding: "utf8" });
    expect(cloned.status, cloned.stderr).toBe(0);
    expect(() => draft(shallow)).toThrow("is a shallow clone");
    expect(() => nextVersion(shallow)).toThrow("is a shallow clone");
  });

  test("the titles since the tag, by section and platform, each linked to its pull request", () => {
    const dir = repository(
      [
        "Phase 9: Google (Gmail) (#88)",
        "Slack fake: an old title (#95)",
        "feat(slack): a person shares files (#96)",
        "fix(github,linear): webhooks retry (#97)",
        "feat(sdk-ts)!: waits take an options object (#98)",
        "chore(deps): bump hono (#99)",
        "docs(slack): the Slack page (#100)",
        "fix(docs,gmail): a typo in an error (#101)",
        "refactor(server)!: drop the --old flag (#102)",
        "feat(pytest): a fixture for Gmail (#103)",
        "test(slack): one more (#104)",
      ],
      1,
    );
    const link = (pr: number) => `([#${pr}](https://github.com/christian-bromann/channelstack/pull/${pr}))`;
    expect(lastTag(dir)).toBe("v0.1.0");
    expect(draft(dir)).toBe(
      [
        "### The fakes",
        "",
        "- **Slack:**",
        `  - A person shares files ${link(96)}`,
        "- **GitHub:**",
        `  - Webhooks retry ${link(97)}`,
        "- **Linear:**",
        `  - Webhooks retry ${link(97)}`,
        "- **Gmail:**",
        `  - A typo in an error ${link(101)}`,
        "",
        "### Testing",
        "",
        "- **pytest-channelstack:**",
        `  - A fixture for Gmail ${link(103)}`,
        "",
        "### Tools",
        "",
        "- **The server:**",
        `  - **Breaking:** Drop the --old flag ${link(102)}`,
        "",
        "### Packages",
        "",
        "- **The TypeScript SDK:**",
        `  - **Breaking:** Waits take an options object ${link(98)}`,
        "",
        "### Other",
        "",
        `- Slack fake: an old title ${link(95)}`,
      ].join("\n"),
    );
  });

  test("before 1.0, a breaking change or a feature bumps the minor version, a fix the patch version", () => {
    expect(nextVersion(repository(["Phase 9 (#88)", "fix(slack): a (#1)", "chore(ci): b (#2)"], 1))).toBe("0.1.1");
    expect(nextVersion(repository(["Phase 9 (#88)", "fix(slack): a (#1)", "feat(github): b (#2)"], 1))).toBe("0.2.0");
    expect(nextVersion(repository(["Phase 9 (#88)", "fix(server)!: a (#1)"], 1))).toBe("0.2.0");
    expect(() => nextVersion(repository(["Phase 9 (#88)"], 1))).toThrow("Nothing to release");
  });

  test("the hand-written Unreleased lines stay, with the draft below them, as the version's section", () => {
    const changelog = "# Changelog\n\n## Unreleased\n\n- Written by hand.\n\n## [0.1.0] - 2026-11-30\n\n- One.\n";
    const out = released(changelog, "0.2.0", "2026-12-15", "### The fakes\n\n- **Slack:**\n  - Drafted\n");
    expect(out).toBe(
      "# Changelog\n\n## Unreleased\n\n## [0.2.0] - 2026-12-15\n\n- Written by hand.\n\n" +
        "### The fakes\n\n- **Slack:**\n  - Drafted\n\n## [0.1.0] - 2026-11-30\n\n- One.\n",
    );
    expect(changelogSection(out, "0.2.0")).toBe("- Written by hand.\n\n### The fakes\n\n- **Slack:**\n  - Drafted");
    expect(changelogSection(out, "0.1.0")).toBe("- One.");
    // The first release: nothing drafted, and nothing after it.
    expect(released("# Changelog\n\n## Unreleased\n\n- All new.\n", "0.1.0", "2026-11-30")).toBe(
      "# Changelog\n\n## Unreleased\n\n## [0.1.0] - 2026-11-30\n\n- All new.\n",
    );
    expect(released("# Changelog\n\n## Unreleased\n", "0.1.1", "2026-12-01", "- Drafted")).toBe(
      "# Changelog\n\n## Unreleased\n\n## [0.1.1] - 2026-12-01\n\n- Drafted\n",
    );
    expect(() => released("# Changelog\n", "0.2.0", "2026-12-15")).toThrow('no "## Unreleased" section');
  });
});
