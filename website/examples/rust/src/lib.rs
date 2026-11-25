//! The Rust versions of the docs' test examples (`<Example id="…" />` in `website/docs`).
//!
//! Each file in `src/` is one example; `build.rs` makes every one a module, so `pnpm test:rust`
//! (clippy over all targets) compiles them all. They are `#[ignore]`d: they need a running
//! channelstack and agent (`cargo test -- --ignored`). What the page shows is the part between the
//! `// @show:start` and `// @show:end` markers; the connection and session come from `fixtures`.
#![cfg(test)]

mod fixtures;

include!(concat!(env!("OUT_DIR"), "/examples.rs"));
