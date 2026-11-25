use channelstack::Result;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn slacks_delivery_specifics() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    let msg = ana.say("hi").to(&slack.app()).await?;
    // @show:start
    slack.uninstall_app().await?; // app_uninstalled and tokens_revoked
    slack
        .fault()
        .r#type("rate_limit")
        .operation("chat.postMessage")
        .retry_after("1s")
        .times(1)
        .await?;
    let delivery = msg.delivery().expect("the fake delivered the message");
    delivery
        .retry()
        .after("3s")
        .reason("http_timeout")
        .await?;
    // @show:end
    session.close().await
}
