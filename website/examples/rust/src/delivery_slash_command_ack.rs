use channelstack::{Handle, Regex, Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn a_slash_command_is_acknowledged_within_3_seconds() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    // @show:start
    let ana = slack.create_user().name("Ana").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;

    let command = ana
        .run_command("/deploy web staging")
        .channel(&channel)
        .await?;

    expect(&command).to_be_accepted().within("3s").await?;
    expect(&channel)
        .to_contain_text(Regex::new("(?i)deploying web to staging")?)
        .await?;
    // @show:end
    session.close().await
}
