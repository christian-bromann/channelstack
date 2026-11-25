//! What the Vitest plugin and pytest give a test, for the Rust examples: a session of its own in a
//! running channelstack. Each test gets its platform fixtures from it (`session.slack()`) and closes
//! it at the end, which removes everything the test created.

use channelstack::{Mode, Result, Session, connect};

/// A new session in the channelstack that is already running (attach mode, as in CI).
pub async fn session() -> Result<Session> {
    let client = connect(Mode::Attach).await?;
    client.open_session().send().await
}
