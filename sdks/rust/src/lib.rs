//! channelstack's Rust SDK: drive the fake (or real) Slack, GitHub, Linear and Notion your agent
//! lives in, as the people who use it.
//!
//! ```no_run
//! # async fn example() -> channelstack::Result<()> {
//! use channelstack::{connect, Handle, Mode};
//!
//! let client = connect(Mode::Auto).await?;
//! let session = client.open_session().send().await?;
//! let slack = session.slack().await?;
//! let ana = slack.create_user().name("Ana").await?;
//! let channel = slack.create_channel().participants(vec![&ana as &dyn Handle, &slack.app()]).await?;
//! let message = ana.say("@my-agent hi").channel(&channel).send().await?;
//! let reply = message.thread().wait_for_reply().from("my-agent").await?;
//! println!("{}", reply.text());
//! # Ok(())
//! # }
//! ```
//!
//! The handles and their methods are generated from the server's routes (`src/generated/`); the
//! runtime under them is the same as the TypeScript and Python SDKs' (`src/runtime`).

pub mod expect;
mod generated;
pub mod runtime;

pub use expect::expect;
pub use generated::*;
/// The pattern type text checks and waits take: `Regex::new("(?i)incident")?`.
pub use regex::Regex;
pub use runtime::client::{Call, Ctx, Dyn, Handle, IntoArg};
pub use runtime::error::{Error, Result};
pub use runtime::launcher::Mode;
