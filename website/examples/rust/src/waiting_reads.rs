use channelstack::{Handle, Result};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn wait_for_and_latest() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    let ben = slack.create_user().name("Ben").admin(true).await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &ben, &slack.app()])
        .await?;
    let msg = ana
        .say("@my-agent deploy web to staging")
        .channel(&channel)
        .await?;
    // @show:start
    // The next new reply from the agent: returns as soon as one arrives.
    let answer = msg.thread().wait_for_reply().from("my-agent").await?;

    // The agent's last reply, once it's done: waits for at least one, then for quiet.
    let ask = msg.thread().latest_reply().from("my-agent").await?;
    ben.click("Approve").message(&ask).await?;
    // @show:end
    let _ = answer;
    session.close().await
}
