# Releasing channelstack

One tag releases the server, the spec and every SDK at the same version
([decision 0023](decisions/0023-releases.md)). The workflow `.github/workflows/release.yml` builds,
checks and publishes it all, and makes the GitHub release.

## A release

1. **The version, in a pull request.** On a branch from `main`:

   ```bash
   pnpm release:version 0.1.0
   ```

   This sets the version in every published manifest:
   - `server/package.json` and `sdks/typescript/package.json`, with its platform packages;
   - both `pyproject.toml` files, and the plugin's pin of the SDK;
   - `sdks/rust/Cargo.toml`.

   It then regenerates the spec and the SDKs (they carry the version they check on connect),
   updates `Cargo.lock` and both `uv.lock` files, and moves the changelog's "Unreleased" section
   under `## [0.1.0] - <today>`.

   Read the diff, edit the changelog's section if it needs it, and open a pull request. Its CI
   includes the release workflow's dry run, which builds every package and binary.
2. **Merge it.**
3. **Tag the merge commit** and push the tag:

   ```bash
   git switch main && git pull
   git tag -s v0.1.0 -m "channelstack 0.1.0"
   git push origin v0.1.0
   ```

   The workflow checks the tag first. It must name the version every package has, it must be on
   `main`, and the changelog must have its section. Then it builds the five binaries, each run once
   on its platform, and every package. It publishes to npm, PyPI and crates.io, and makes the GitHub
   release last.

A run that fails partway can be run again from the Actions tab. What a registry has already is
skipped, since none of them takes the same version twice.

A prerelease (`0.2.0-rc.1`) goes to npm's `next` tag, and its GitHub release is marked as one.

## Once, before the first release

These need the maintainer's accounts, so the workflow can't do them:

- [ ] **npm:** trusted publishing, which npm tries first (npm 11.5.1 or later; Node 24.12 ships
  11.6.2). It trusts the repository `christian-bromann/channelstack`, the workflow `release.yml`
  and the environment `release`.
  - [x] `channelstack`, reserved as `0.0.0-placeholder.0`, trusts the workflow.
  - [ ] The five `@channelstack/server-*` packages, reserved as `0.0.0-placeholder.0` in the
    organization `channelstack`: each needs the trusted publisher above (npm sets it up only for a
    package that exists). Until then, a granular token that may publish `@channelstack/*`, stored
    as `NPM_TOKEN` in the `release` environment, stands in: the workflow uses it only for a
    package that doesn't trust it.
- [x] **PyPI:** a trusted publisher for each project:
  - for `channelstack`, which is reserved already (`0.0.0.dev0`), under its settings;
  - for `pytest-channelstack`, a pending publisher, under the account's publishing settings. A
    pending publisher doesn't reserve the name, so it is reserved as `0.0.0.dev0` too, and trusts
    the workflow under its settings.

  Both trust the repository `christian-bromann/channelstack`, the workflow `release.yml` and the
  environment `pypi`.
- [x] **crates.io:**
  - `channelstack` is reserved as `0.0.0-placeholder.0`, which has no code.
  - An API token that may publish it is stored as `CARGO_REGISTRY_TOKEN` in the `release`
    environment.
- [ ] **GitHub:**
  - Create the environments `release` and `pypi` (Settings → Environments).
  - Limit both to tags `v*`, and add yourself as a required reviewer, so a release waits for your
    approval.
  - Add a tag ruleset that lets only maintainers create `v*` tags.
  - Turn on private vulnerability reporting (Settings → Security), which
    [SECURITY.md](../SECURITY.md) points reporters to. It's off today.
- [ ] **The first release's pull request:** take the README's "not on npm yet" note out.

Once every npm package trusts the workflow, `NPM_TOKEN` can be deleted. crates.io's trusted
publishing can replace `CARGO_REGISTRY_TOKEN` the same way.
