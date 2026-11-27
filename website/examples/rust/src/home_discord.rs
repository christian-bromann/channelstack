//! The home page's Discord example (website/samples/discord.test.ts), in Rust.
// @show:start
use channelstack::{Handle, Mode, Result, connect, expect};

#[ignore = "needs a running agent"] // @hide
#[tokio::test]
async fn answers_a_mention_once_quoting_it() -> Result<()> {
    let client = connect(Mode::Auto).await?;
    let test_session = client.open_session().send().await?;
    let discord = test_session.discord().await?;
    let ana = discord.create_user().name("Ana").await?;
    let channel = discord
        .create_channel()
        .name("support")
        .participants(vec![&ana as &dyn Handle, &discord.app()])
        .await?;
    // [!step 1]
    let msg = ana
        .say("@my-agent why is the build red?")
        .channel(&channel)
        .await?;

    // [!step 2]
    let answer = msg.wait_for_reply().from("my-agent").await?;
    // [!step 3]
    assert_eq!(answer.reply_to(), Some(msg.id()));
    // [!step 4]
    expect(&msg).to_have_replies_from("my-agent", 1).await?;

    test_session.close().await
}
// @show:end
