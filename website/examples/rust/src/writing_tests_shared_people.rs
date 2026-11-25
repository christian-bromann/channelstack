use channelstack::{Handle, Result, SlackConversation, SlackFixture, SlackUser, expect};

use crate::fixtures;

// @show:start
// Rust has no test.extend: shared people and places are helpers each test calls.
async fn ana(slack: &SlackFixture) -> Result<SlackUser> {
    slack.create_user().name("Ana").await
}

async fn ben(slack: &SlackFixture) -> Result<SlackUser> {
    slack.create_user().name("Ben").admin(true).await
}

async fn support(
    slack: &SlackFixture,
    ana: &SlackUser,
    ben: &SlackUser,
) -> Result<SlackConversation> {
    slack
        .create_channel()
        .name("support")
        .participants(vec![ana as &dyn Handle, ben, &slack.app()])
        .await
}

#[tokio::test]
#[ignore = "needs a running agent"]
async fn an_admin_and_a_regular_member_see_the_same_answer() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let (ana, ben) = (ana(&slack).await?, ben(&slack).await?);
    let support = support(&slack, &ana, &ben).await?;

    let question = ana
        .say("@my-agent who's on call?")
        .channel(&support)
        .await?;
    ben.reply("+1, also need this").thread(&question).await?;

    expect(&question.thread())
        .to_have_replies_from("my-agent", 1)
        .await?;
    session.close().await
}
// @show:end
