# 0024: The changelog is drafted from pull request titles

Status: proposed, 2026-11-26. The maintainer confirms it in the PR that adds `cliff.toml`.

## What was decided

- **The title is the record.** Every pull request is squash-merged with its title as the commit
  title, so the title is what reaches git. It is a Conventional Commit,
  `<type>(<scope>)<!>: <summary>`, from a fixed list:
  - types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `ci`, `build`, `chore`;
  - scopes: the fakes (`slack`, `github`, `linear`, `notion`, `resend`, `gmail`), the packages
    (`server`, `sdk-ts`, `sdk-python`, `pytest`, `sdk-rust`), and the internal ones (`docs`, `ci`,
    `codegen`, `deps`). A title may have several, separated by commas.
- **A check enforces it.** `.github/workflows/pr-title.yml` runs
  `amannn/action-semantic-pull-request` (MIT, pinned by SHA) on `pull_request_target`, so a pull
  request from a fork is checked too. It only reads the title from the event, with a token that can
  only read pull requests, and never checks out the pull request's code. The maintainer makes it a
  required status check in a branch ruleset on `main` (docs/release.md).
- **git-cliff drafts, the maintainer writes.** `pnpm release:version` puts git-cliff's draft of the
  pull requests since the last `v*` tag below the hand-written "Unreleased" lines. `cliff.toml`
  sorts it into the changelog's own sections, by scope, with a link to each pull request. The
  maintainer edits it into the changelog: CHANGELOG.md stays written for people, in Keep a
  Changelog's form.
- **The version comes from the titles too.** Without a version, `release:version` takes git-cliff's
  `--bumped-version`. Before 1.0, a breaking change or a feature bumps the minor version and a fix
  the patch version (`features_always_bump_minor`, `breaking_always_bump_major = false`).
- **History isn't rewritten.** Titles from before the convention ("Slack fake: …", "Phase 9: …")
  stay. The first draft starts after `v0.1.0`, whose section is all hand-written, and a title the
  draft can't place is listed under "Other".

## Why git-cliff

- MIT or Apache-2.0, released every few months (2.14.2 on 2026-09-18), and widely used.
- The npm package `git-cliff` ships a prebuilt binary per platform as optional dependencies, so it
  installs with the other dev dependencies, with no Rust toolchain, no install script, and no native
  Node module. Only `release.ts` runs it: `version` in the **Prepare a release** workflow on GitHub, and
  `draft` wherever someone previews the draft. It isn't part of the server or its compiled binary.
- Its configuration is one file, its templates can group by scope, and it computes the next version
  from the same commits.

## Alternatives

- **Labels on pull requests** (release-drafter, GitHub's generated release notes): labels never
  reach git, so a changelog built from them depends on GitHub's API and on every label being set
  by hand. A title does both jobs.
- **Changesets:** a file per change, written in the pull request. More precise, but it is a second
  place to describe a change, and it is built for many independently versioned packages, while
  channelstack releases everything at one version (decision 0023).
- **conventional-changelog or semantic-release:** Node-only and built to publish on their own;
  channelstack's release workflow already publishes, and needs only a draft.
- **A hand-written parser in `release.ts`:** AGENTS.md prefers a maintained library to our own
  code for what isn't the product.
