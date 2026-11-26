# Contributing to channelstack

Thanks for helping. Issues and pull requests are welcome: bug reports, a fake that doesn't do what
the real platform does, a gap in the docs, a new check.

## Before you start

- **For a bug,** open an issue with what you ran, what you expected and what happened. For a fake
  that differs from the real platform, say how you know: a link to the platform's docs, or what the
  real API answered.
- **For anything larger** than a fix, open an issue first, so we can agree on the shape before you
  build it. The settled decisions are in [AGENTS.md](AGENTS.md) and [docs/decisions/](docs/decisions/).
- **Security problems** don't go in an issue: see [SECURITY.md](SECURITY.md).

## Setting up

You need Node 24, pnpm (the version in `package.json`), Bun (installed with the dependencies),
Rust (from `rust-toolchain.toml`) and [uv](https://docs.astral.sh/uv/) for the Python packages.

```bash
pnpm install
pnpm build          # the TypeScript SDK and this machine's server binary
pnpm test           # the unit tests, TypeScript and Python
pnpm test:accept    # the acceptance suite, against the reference agents
```

`pnpm verify:phase <n>` runs everything CI runs. [docs/code-map.md](docs/code-map.md) says which
module owns what, and [AGENTS.md](AGENTS.md) has the rules the code follows. Coding agents follow
them too.

## A pull request

- **One concern per pull request,** with a test that fails without it.
- **Before writing a function, search** [docs/code-map.md](docs/code-map.md) and the code: each
  concern has one owner, and a second implementation won't be merged.
- **A fake does what the real platform does:** the same ids, payloads and error codes, and the same
  refusals.
- **`api/*.d.ts` is the contract.** If a change needs it to change, say why in the pull request.
- **Generated files** (`spec/`, `sdks/*/generated/`, the API reference) are regenerated with
  `pnpm spec` and `pnpm sdk`, never edited by hand.
- **Format and check** with `pnpm format`, then `pnpm lint`.
- **Docs:** update the ones your change touches, in the same pull request.

## Releases

Maintainers release from GitHub's Actions tab; see [docs/release.md](docs/release.md).

## Code of conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
