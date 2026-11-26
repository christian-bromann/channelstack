# Releasing channelstack

One tag releases the server, the spec and every SDK at the same version
([decision 0023](decisions/0023-releases.md)). Everything happens on GitHub: no one releases from
their own machine, and no machine but GitHub's holds what publishing needs.

| Workflow | Started by | What it does |
|---|---|---|
| `release-prepare.yml` | you, from the Actions tab | opens the version pull request |
| `release-tag.yml` | that pull request's merge | tags the merge commit `vX.Y.Z` |
| `release.yml` | the tag | builds, checks and, after your approval, publishes, then makes the GitHub release |

## A release

1. **Prepare it.** Actions → **Prepare a release** → **Run workflow** on `main`. Leave the version
   empty to take the next one from the pull requests merged since the last `v*` tag (git-cliff's
   `--bumped-version`): before 1.0, a breaking change (`!`) or a `feat` bumps the minor version,
   and a `fix` or `perf` the patch version. Name the version to choose it yourself, as for the first
   release (`0.1.0`) or a prerelease (`0.2.0-rc.1`). The workflow runs `pnpm release:version`,
   which:
   - sets the version in every published manifest: `server/package.json` and
     `sdks/typescript/package.json` with its platform packages, both `pyproject.toml` files and the
     plugin's pin of the SDK, and `sdks/rust/Cargo.toml`;
   - regenerates the spec and the SDKs (they carry the version they check on connect), and updates
     `Cargo.lock` and both `uv.lock` files;
   - moves the changelog's "Unreleased" section under `## [0.1.0] - <today>`, with a draft from the
     pull requests' titles below the hand-written lines (see "The changelog" below).

   It then opens the pull request `chore(ci): release v0.1.0` from the branch `release/v0.1.0`. Its CI
   includes the release workflow's dry run, which builds every package and binary.
2. **Review it.** Edit the changelog's section on the branch into sentences a user reads (merge the
   draft into the hand-written lines, drop what isn't worth saying), and merge the pull request
   once CI is green. Merge nothing else in the meantime: a pull request merged after the draft
   ships in the release but is in no draft, since the tag lands on top of it. If one does, close
   the version pull request and run **Prepare a release** again.
3. **Approve it.** The merge makes `release-tag.yml` tag the merge commit `v0.1.0`; only the release
   App may create `v*` tags. The tag starts `release.yml`, which checks it first: it must name the
   version every package has, it must be on `main`, and the changelog must have its section. Then it
   builds the five binaries, each run once on its platform, and every package. The publishing jobs
   wait for your approval: open the run, then **Review deployments**, tick `release` and `pypi`, and
   approve. It publishes to npm, PyPI and crates.io, and makes the GitHub release last.

A run that fails partway can be run again from the Actions tab. What a registry has already is
skipped, since none of them takes the same version twice.

A prerelease (`0.2.0-rc.1`) goes to npm's `next` tag, and its GitHub release is marked as one.

## The changelog

CHANGELOG.md is written for people, in Keep a Changelog's form
([decision 0024](decisions/0024-changelog-from-pr-titles.md)). Write what users should know under
"Unreleased" as you go; `release:version` adds a draft below it from the titles of the pull
requests merged since the last `v*` tag (CONTRIBUTING.md, "The title"):

- `cliff.toml` sorts the draft into the changelog's sections: "The fakes" with a bullet per
  platform, "Testing", "Tools" and "Packages".
- It links each entry to its pull request, and marks a breaking change.
- It leaves out the internal scopes and the types that aren't `feat`, `fix` or `perf`.
- A title without one of the listed scopes, such as one from before the convention, is under
  "Other".
- Before the first tag there is nothing to draft from, so 0.1.0's section is all hand-written.
- A release of only internal changes (say, `fix(deps): …` for a vulnerability) has nothing that
  bumps the version, so **Prepare a release** with an empty version fails with "Nothing to
  release". Name the version (`0.2.1`), and write its section by hand.
- A prerelease's tag counts as the last tag. After `v0.2.0-rc.1`, the draft has only what was
  merged since the rc, and the next version is `0.2.0-rc.2`: name `0.2.0` to release it, and copy
  the rc's section into it.

To see the draft without changing anything (it needs the history and the tags, so not a shallow
clone):

```bash
pnpm release:draft
```

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
  - Add a branch ruleset on `main` (Settings → Rules → Rulesets → New branch ruleset, target the
    default branch) with **Require status checks to pass** and the check `PR title`, so a pull
    request whose title the changelog can't use isn't merged. The check runs on
    `pull_request_target`, from `main`'s copy of `.github/workflows/pr-title.yml`. In the same
    ruleset, **Require a pull request before merging** with **Allowed merge methods: Squash** only.
  - Make the checked title the commit's title (Settings → General → Pull Requests): allow squash
    merging only, with the default commit message **Pull request title**, or **Pull request title
    and description**. Today a pull request with one commit is squashed under that commit's own
    title (`COMMIT_OR_PR_TITLE`), which the check never saw, and merge commits and rebase merges
    are allowed too.
  - Create the environments `release` and `pypi` (Settings → Environments).
  - Limit both to tags `v*`, and add yourself as a required reviewer, so a release waits for your
    approval.
  - Add a tag ruleset that lets only maintainers create `v*` tags.
  - Turn on private vulnerability reporting (Settings → Security), which
    [SECURITY.md](../SECURITY.md) points reporters to. It's off today.
- [ ] **The release App,** which opens the version pull request and creates the tag (a pull
  request or tag `GITHUB_TOKEN` creates starts no workflow, and the tag ruleset lets only this App
  create tags):
  - Create a GitHub App (Settings → Developer settings → GitHub Apps → New GitHub App), named for
    example `channelstack-release`, with no webhook and the repository permissions **Contents:
    Read and write** and **Pull requests: Read and write**. Install it on this repository only.
  - Create the environment `release-bot`, limited to the branch `main`. Store the App's client id
    as its variable `RELEASE_APP_CLIENT_ID`, and a private key you generate on the App's page as its
    secret `RELEASE_APP_PRIVATE_KEY`. Delete the downloaded key file afterwards.
  - In the tag ruleset, replace **Repository admin** in the bypass list with the App, so a `v*` tag
    can only come from `release-tag.yml`.
- [ ] **No publishing from a laptop:**
  - crates.io: `cargo logout`, and revoke any token but the one in the `release` environment.
  - npm: under each package's settings, set publishing access to **Require two-factor
    authentication and disallow tokens**; trusted publishing still works.
  - PyPI: revoke the API token the placeholder was uploaded with.
- [ ] **The first release's pull request:** take the README's "not on npm yet" note out. The
  version pull request lists it.

Once every npm package trusts the workflow, `NPM_TOKEN` can be deleted. crates.io's trusted
publishing can replace `CARGO_REGISTRY_TOKEN` the same way.
