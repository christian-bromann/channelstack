use channelstack::{Handle, Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_channel_the_app_isnt_in_stays_silent_until_its_invited() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    // @show:start
    let ana = slack.create_user().name("Ana").admin(true).await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle])
        .await?;

    let first = ana.say("@my-agent are you here?").channel(&channel).await?;
    expect(&first.thread())
        .not_to_have_reply_from("my-agent")
        .await?;

    ana.invite(&slack.app()).channel(&channel).await?;
    let second = ana.say("@my-agent now?").channel(&channel).await?;
    expect(&second.thread())
        .to_have_reply_from("my-agent")
        .await?;
    // @show:end
    session.close().await
}
