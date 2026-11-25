use channelstack::{Handle, Regex, Result, expect};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn allowlisted_people_by_fixed_id() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    // @show:start
    let admin = slack.create_user().name("Cara").id("U0ADMIN01").await?;
    let stranger = slack.create_user().name("Dev").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&admin as &dyn Handle, &stranger, &slack.app()])
        .await?;

    let allowed = admin
        .say("@my-agent rotate the API keys")
        .channel(&channel)
        .await?;
    let refused = stranger
        .say("@my-agent rotate the API keys")
        .channel(&channel)
        .await?;

    expect(&allowed.thread())
        .to_have_reply_from("my-agent")
        .text(Regex::new("(?i)rotating")?)
        .await?;
    expect(&refused.thread())
        .to_have_reply_from("my-agent")
        .text(Regex::new("(?i)not allowed")?)
        .await?;
    // @show:end
    session.close().await
}
