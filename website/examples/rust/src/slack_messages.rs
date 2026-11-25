use channelstack::{Handle, Result};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn what_people_write_in_slack() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;
    // @show:start
    let msg = ana
        .say("@my-agent what's the status of the web deploy?")
        .channel(&channel)
        .await?;
    msg.thread().wait_for_reply().from("my-agent").await?;

    ana.reply("and the API?").thread(&msg).await?;
    ana.edit("@my-agent what's the status of the web deploy today?")
        .message(&msg)
        .await?;
    ana.react("ticket").message(&msg).await?;
    ana.delete().message(&msg).await?;
    // @show:end
    session.close().await
}
