use channelstack::{Handle, Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn survives_slacks_3s_retry_without_answering_twice() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    // @show:start
    let ana = slack.create_user().name("Ana").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;
    let msg = ana.say("@my-agent hi").channel(&channel).await?;

    let delivery = msg.delivery().expect("the fake delivered the message");
    delivery.retry().after("3s").reason("http_timeout").await?;

    expect(&msg.thread())
        .to_have_replies_from("my-agent", 1)
        .await?;
    // @show:end
    session.close().await
}
