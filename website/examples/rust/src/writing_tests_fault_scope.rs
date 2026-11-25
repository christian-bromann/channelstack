use channelstack::{Handle, Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn still_answers_when_slack_refuses_a_message_as_too_long() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    // @show:start
    let ana = slack.create_user().name("Ana").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;
    let fault = slack
        .fault()
        .r#type("error")
        .operation("chat.postMessage")
        .error("msg_too_long")
        .times(1)
        .await?;

    let msg = ana.say("@my-agent hello").channel(&channel).await?;

    expect(&msg.thread())
        .to_have_replies_from("my-agent", 1)
        .await?;
    // Rust has no async drop: undo the fault where its scope ends.
    fault.undo().await?;
    // @show:end
    session.close().await
}
