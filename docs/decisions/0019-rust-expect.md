# 0019: Rust checks are `expect(&subject).to_…().await?`, in the SDK crate

Status: accepted, between phases (PR #53).

The Rust SDK has the matchers of `channelstack/vitest`, with matchers-core's semantics and failure messages, in
the `channelstack` crate itself (`sdks/rust/src/expect/`):

```rust
use channelstack::{Regex, expect};

expect(&thread).to_have_reply_from("my-agent").text(Regex::new("(?i)incident")?).await?;
expect(&thread.conversation()).not_to_have_channel_message_from(&app).quiet_for("2s").await?;
```

- **In the crate.** `expect` is `channelstack::expect`, not a separate test crate.
- **Awaited builders.** `expect(&subject)` returns the checks; each check is a builder of its options (`text`,
  `from`, `timeout`, `quiet_for`) that awaits to `Result<()>`, as every SDK call does
  (architecture.md section 5).
- **`not_to_…` methods.** A negation is its own method, as in pytest ([decision 0018](0018-pytest-expect.md)). Both
  forms share one builder type, with a `const NOT: bool` parameter, so they take the same options and differ only
  in what they wait for and what they say.
- **`Error::Expectation`.** A failed check is a variant of the SDK's one `Error`, holding matchers-core's whole
  message. Its `Debug` prints that message as it is, lines included, so `?` in a test that returns
  `channelstack::Result` fails with a readable message.
- **Checks exist only where they can read.** What each check reads is a trait per read (`subjects.rs`),
  implemented for the handles that have it, so `expect(&delivery).to_have_label("bug")` doesn't compile. A unit
  test checks a stand-in that implements the same traits.
- **Patterns are `regex::Regex`, re-exported** as `channelstack::Regex`. Inline flags (`(?i)`) are how Rust
  spells case-insensitive; on the wire a leading flag group becomes the pattern's `flags`, as the server's
  patterns are JavaScript's (`pattern_on_wire` in the runtime's `wait`).

## Why

- **Rust has no test framework to plug into.** `#[test]` and `#[tokio::test]` have no matcher extension point like
  Vitest's `expect.extend` or pytest's fixtures, so there is no integration package to write: the checks are an API
  of the SDK, and a test needs one dependency, not two.
- **One vocabulary.** A team with agents in TypeScript, Python and Rust reads the same check names in each, and the
  docs explain each matcher once (the docs' `<Example>` shows all three).
- **Checks wait.** They poll or wait for a quiet window, so they are futures. A builder that awaits to `Result`
  works with `?` in any async test and needs no macro.
- **Errors stay one type.** A test that returns `channelstack::Result` can `?` both SDK calls and checks.

## Alternatives considered

- **A `channelstack-test` crate.** Rejected: there is no framework for it to adapt, so it would only move the same
  code into a second crate that every user adds and keeps on the same version as the SDK.
- **`assert!`-style macros** (`assert_reply_from!(thread, "my-agent")`). Rejected: a macro can't take the checks'
  optional settings as readably as builder methods, hides the `.await`, and is a second vocabulary next to the other
  languages' `expect`.
- **`.not()` on the expectation** (`expect(&t).not().to_have_reply_from(…)`), as Vitest's `.not.`. Rejected: it
  would work, but `not_to_…` reads as one name, lists each negation in the docs next to its positive form, and
  matches pytest's spelling, so the two non-TypeScript SDKs read the same.
- **`anyhow` errors.** Rejected: the SDK's errors are one typed `Error` whose `Api` variant carries the protocol's
  error code, so a test can match on a refusal. `anyhow` would erase that, and a failed check would no longer be
  distinguishable from a refused call.
