# 0023: How channelstack is released

Status: proposed, 2026-11-26, for the first open-source release. The maintainer confirms it in
the PR that adds the release workflow.

## What is published, from one tag

A tag `vX.Y.Z` on `main` releases everything at that version (architecture.md, section 6). The
workflow `.github/workflows/release.yml` builds and checks it all first, then publishes:

| Where | What |
|---|---|
| npm | `@channelstack/server-<platform>-<arch>` for the five targets, then `channelstack`, which names them as optional dependencies |
| PyPI | `channelstack` and `pytest-channelstack` |
| crates.io | `channelstack` |
| GitHub | a release with the five binaries, their SHA-256 checksums, the spec and the changelog's section |

A version is `X.Y.Z`, or a prerelease `X.Y.Z-alpha.N`, `-beta.N` or `-rc.N`, on npm's `next` tag.
PyPI spells a prerelease in PEP 440's way (`X.Y.ZrcN`); everything else takes it as it is.
`node scripts/release.ts version <version>` writes it everywhere, and `release:check`, a standing
check of the gate, fails when two packages disagree.

## Published libraries take ranges

AGENTS.md pins every dependency to an exact version, and the repository keeps that: `pnpm-lock.yaml`,
`uv.lock` and `Cargo.lock` pin what CI tests. A library's published manifest is different. Its
dependency specs are what every project that installs it must satisfy, next to its own
dependencies. An exact pin there makes the package impossible to install beside any other version:
`tokio = "=1.54.1"` in the crate would clash with nearly every Tokio project, and `pytest==8.4.2`
in `pytest-channelstack` with a project's own pytest.

So the published Python and Rust manifests take a range from the version CI tests up to the next
major version (`httpx>=0.28.1,<1`, Cargo's default `^`), and the lock files keep pinning exactly.
`pytest-channelstack` pins the SDK of its own release (`channelstack==X.Y.Z`). The npm package has
no runtime dependencies besides its platform packages, which it pins. When CI moves a lock file to a
new major version, the range moves with it.

## Credentials

- **npm:** trusted publishing, so no token is stored once every package trusts `release.yml` in
  the `release` environment. npm sets it up only for a package that exists, so the five platform
  packages need a placeholder first, or a token in the `release` environment (`NPM_TOKEN`) for the
  first release; npm uses the token only for a package that doesn't trust the workflow. Every
  package gets npm's provenance.
- **PyPI:** trusted publishing, so no token is stored: both projects trust `release.yml` in the
  `pypi` environment.
- **crates.io:** a token in the `release` environment (`CARGO_REGISTRY_TOKEN`). Trusted publishing can
  replace it once the crate exists.

The publishing jobs run only for a pushed tag, in those environments, and wait for the maintainer's
approval there. Nothing but the tag starts the release workflow; every pull request's CI builds
the binaries and the packages the same way, so the version pull request is checked before the tag
(2026-11-27: pull requests that touched a release file used to start the release workflow as a dry
run).

## Released from GitHub only

No one releases from their own machine. A workflow started from the Actions tab opens the version
pull request (`release-prepare.yml`); merging it makes another tag the merge commit
(`release-tag.yml`), and the tag starts `release.yml`. Both use a GitHub App's token: a pull request
or tag that `GITHUB_TOKEN` creates starts no workflow, and the tag ruleset lets only the App create
`v*` tags, so a tag can't come from a laptop. The App can write contents and pull requests and
nothing else, and its key is a secret of the `release-bot` environment, which only `main` can use.
No laptop holds a registry token either: npm and PyPI trust the workflow, and crates.io's token is a
secret of the `release` environment.

## Alternatives

- **Publishing from a maintainer's machine:** no provenance, and nothing ties a package to the
  commit it came from.
- **Tagging from a maintainer's machine,** with the workflow publishing: the release would still
  depend on a laptop's git setup, and on whoever holds a tag-creating role.
- **A personal access token** for the version pull request and the tag: tied to a person, broader
  than the two permissions the App has, and long-lived.
- **One workflow per registry:** the versions could drift, and a release could be half done
  without anyone seeing it in one place.
- **Exact pins in published manifests**, as in the repository: rejected for the reason above.
- **A Docker image** (`ghcr.io/<org>/channelstack`, architecture.md section 6): not in the first
  release. How a container hands its control API's token to an SDK on the host isn't designed yet.
