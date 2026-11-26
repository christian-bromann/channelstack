/**
 * One version for everything channelstack publishes (architecture.md, section 6: one tag releases
 * the server, the spec and every SDK at the same version), and the check the release workflow and
 * the gate run.
 *
 *   node scripts/release.ts version <version>   # every manifest, the spec, the SDKs, the lock files, the changelog
 *   node scripts/release.ts check [--tag <tag>] # all agree (and match the tag, with its changelog section)
 *   node scripts/release.ts notes <version>     # the changelog section of a version, for the GitHub release
 *
 * A version is `X.Y.Z` or a prerelease `X.Y.Z-alpha.N`, `-beta.N` or `-rc.N`. PyPI spells a
 * prerelease its own way (PEP 440: `X.Y.ZrcN`); everything else takes it as it is.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Nothing but Node: the release jobs run `check` and `notes` before anything is installed.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Run a command in the repository, its output on this terminal. Throws when it fails. */
function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/;

/** A version as PyPI writes it: `0.1.0-rc.1` is `0.1.0rc1`. */
export function pep440(version: string): string {
  const found = VERSION.exec(version);
  if (!found) throw new Error(`"${version}" isn't X.Y.Z or X.Y.Z-(alpha|beta|rc).N`);
  const [, major, minor, patch, pre, number] = found;
  const tag = pre === undefined ? "" : `${{ alpha: "a", beta: "b", rc: "rc" }[pre]}${number}`;
  return `${major}.${minor}.${patch}${tag}`;
}

/** A path in the repository. */
const at = (...parts: string[]) => join(ROOT, ...parts);
const read = (path: string) => readFileSync(at(path), "utf8");

/** The published manifests, each with how to read and write its version. */
const NPM = ["server/package.json", "sdks/typescript/package.json"] as const;
const PYPI = ["sdks/python/pyproject.toml", "integrations/pytest-channelstack/pyproject.toml"] as const;
const CRATE = "sdks/rust/Cargo.toml";
/** Each published package carries the repository's license. */
const LICENSES = [
  "sdks/typescript/LICENSE",
  "sdks/python/LICENSE",
  "integrations/pytest-channelstack/LICENSE",
  "sdks/rust/LICENSE",
] as const;

/** The first `version = "…"` of a TOML file's first table (`[project]`, `[package]`). */
const TOML_VERSION = /^version = "([^"]*)"$/m;
/** The pytest plugin's pin of the SDK it was released with. */
const SDK_PIN = /"channelstack==([^"]*)"/;

/** Every version the manifests carry, by where it is. */
export function versions(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const path of NPM) {
    const manifest = JSON.parse(read(path)) as { version: string; optionalDependencies?: Record<string, string> };
    found[path] = manifest.version;
    for (const [name, version] of Object.entries(manifest.optionalDependencies ?? {})) {
      found[`${path} ${name}`] = version;
    }
  }
  for (const path of PYPI) found[path] = TOML_VERSION.exec(read(path))?.[1] ?? "(none)";
  found[`${PYPI[1]} channelstack==`] = SDK_PIN.exec(read(PYPI[1]))?.[1] ?? "(none)";
  found[CRATE] = TOML_VERSION.exec(read(CRATE))?.[1] ?? "(none)";
  found["spec/openapi.json"] = (JSON.parse(read("spec/openapi.json")) as { info: { version: string } }).info.version;
  return found;
}

/** The changelog section of a version: what follows `## [<version>]` up to the next `## `. */
export function changelogSection(changelog: string, version: string): string | undefined {
  const heading = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\][^\\n]*\\n`, "m");
  const start = heading.exec(changelog);
  if (!start) return undefined;
  const rest = changelog.slice(start.index + start[0].length);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** What doesn't agree: versions that differ, a tag they don't match, a missing changelog section, a stale license. */
export function problems(options: { tag?: string | undefined } = {}): string[] {
  const found = versions();
  const out: string[] = [];
  const expected = options.tag === undefined ? found[NPM[1]] : options.tag.replace(/^v/, "");
  if (options.tag !== undefined && !VERSION.test(expected ?? "")) {
    out.push(`the tag ${options.tag} isn't vX.Y.Z or vX.Y.Z-(alpha|beta|rc).N`);
  }
  for (const [where, version] of Object.entries(found)) {
    const wanted = where.startsWith("sdks/python") || where.startsWith("integrations/") ? pep440Or(expected) : expected;
    if (version !== wanted) out.push(`${where} is ${version}, not ${wanted}`);
  }
  if (options.tag !== undefined && changelogSection(read("CHANGELOG.md"), expected ?? "") === undefined) {
    out.push(`CHANGELOG.md has no "## [${expected}]" section`);
  }
  const license = read("LICENSE");
  for (const path of LICENSES) {
    let copy: string | undefined;
    try {
      copy = read(path);
    } catch {
      copy = undefined;
    }
    if (copy !== license) out.push(`${path} isn't a copy of LICENSE`);
  }
  return out;
}

/** `pep440`, or the text as it is when it isn't a version (the problem is reported elsewhere). */
const pep440Or = (version: string | undefined) => {
  try {
    return pep440(version ?? "");
  } catch {
    return version;
  }
};

/** Set every manifest to `version`, then regenerate what follows from it. */
function setVersion(version: string): void {
  const python = pep440(version);
  for (const path of NPM) {
    const manifest = JSON.parse(read(path)) as { version: string; optionalDependencies?: Record<string, string> };
    manifest.version = version;
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      (manifest.optionalDependencies as Record<string, string>)[name] = version;
    }
    writeFileSync(at(path), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  for (const path of PYPI) {
    let text = read(path).replace(TOML_VERSION, `version = "${python}"`);
    text = text.replace(SDK_PIN, `"channelstack==${python}"`);
    writeFileSync(at(path), text);
  }
  writeFileSync(at(CRATE), read(CRATE).replace(TOML_VERSION, `version = "${version}"`));

  // The changelog: what is unreleased becomes this version's section, under a new empty one.
  const changelog = read("CHANGELOG.md");
  if (changelogSection(changelog, version) === undefined) {
    const today = new Date().toISOString().slice(0, 10);
    const moved = changelog.replace(/^## Unreleased$/m, `## Unreleased\n\n## [${version}] - ${today}`);
    if (moved === changelog) throw new Error('CHANGELOG.md has no "## Unreleased" section to release');
    writeFileSync(at("CHANGELOG.md"), moved);
  }

  // The spec carries the server's version, and every SDK the spec's.
  run("pnpm", ["spec"]);
  run("pnpm", ["sdk"]);
  run("cargo", ["update", "--workspace"]);
  for (const project of PYPI) run("uv", ["lock", "--project", project.replace(/\/pyproject\.toml$/, "")]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, value] = process.argv.slice(2);
  if (command === "version" && value !== undefined) {
    pep440(value);
    setVersion(value);
    const left = problems();
    if (left.length > 0) throw new Error(`After setting the version:\n${left.join("\n")}`);
    console.log(`Every package is at ${value} now. Review the diff, then open a pull request.`);
  } else if (command === "check") {
    const tagAt = process.argv.indexOf("--tag");
    const tag = tagAt === -1 ? undefined : process.argv[tagAt + 1];
    const left = problems({ tag });
    if (left.length > 0) {
      console.error(left.map((line) => `release: ${line}`).join("\n"));
      process.exit(1);
    }
    console.log(`release: every package is at ${versions()[NPM[1]]}${tag ? `, as ${tag} says` : ""}`);
  } else if (command === "notes" && value !== undefined) {
    const section = changelogSection(read("CHANGELOG.md"), value);
    if (section === undefined) throw new Error(`CHANGELOG.md has no "## [${value}]" section`);
    console.log(section);
  } else {
    console.error("Usage: node scripts/release.ts version <version> | check [--tag <tag>] | notes <version>");
    process.exit(2);
  }
}
