use channelstack::{Handle, Regex, Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn approval_buttons_act_once_even_on_a_double_click() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    // @show:start
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

    let ask = msg.thread().latest_reply().from("my-agent").await?;
    expect(&ask).to_have_button("Approve").await?;

    ben.click("Approve").message(&ask).await?;
    ben.click("Approve").message(&ask).await?;

    expect(&msg.thread())
        .to_contain_text("Deploying")
        .count(1)
        .await?;
    expect(&slack)
        .not_to_have_received_call(Regex::new(".*")?)
        .error("not_in_channel")
        .await?;
    // @show:end
    session.close().await
}
