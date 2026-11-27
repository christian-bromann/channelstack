//! The reply matchers on a Discord message and channel, against a server the SDK starts
//! (`Mode::Start`, with `CHANNELSTACK_SERVER_BIN`). No agent runs: Ben answers Ana with Discord's
//! reply, so every check is about what they said. `pnpm test:rust` sets the binary; without it, the
//! test says so and passes.

use channelstack::{Error, Handle, Mode, connect, expect};

#[tokio::test]
async fn reply_matchers_read_a_discord_message_and_channel() -> channelstack::Result<()> {
    if std::env::var("CHANNELSTACK_SERVER_BIN").is_err() {
        eprintln!("skipped: set CHANNELSTACK_SERVER_BIN (pnpm test:rust does)");
        return Ok(());
    }
    let client = connect(Mode::Start).await?;
    let session = client
        .open_session()
        .name("rust-expect-discord")
        .send()
        .await?;

    let discord = session.discord().await?;
    let ana = discord.create_user().name("Ana").await?;
    let ben = discord.create_user().name("Ben").await?;
    let channel = discord
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &ben])
        .await?;
    let msg = ana.say("Lunch at noon?").channel(&channel).await?;
    ben.reply("Noon works").message(&msg).await?;

    // A message's replies are Discord's replies to it.
    expect(&msg)
        .to_have_reply_from(&ben)
        .text("Noon works")
        .await?;
    expect(&msg).to_have_replies_from(&ben, 1).await?;
    expect(&msg).not_to_have_reply_from(&discord.app()).await?;
    match expect(&msg).to_have_replies_from(&ben, 2).await {
        Err(Error::Expectation(message)) => assert!(message.contains("found 1"), "{message}"),
        other => panic!("expected a failed check, got {other:?}"),
    }
    // A channel's are everything said in it.
    expect(&channel).to_have_replies_from(&ana, 1).await?;
    expect(&channel).to_have_replies_from(&ben, 1).await?;

    session.close().await?;
    client.close().await;
    Ok(())
}
