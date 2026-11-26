//! The home page's Slack example (website/samples/hero.test.ts), in Rust.
// @show:start
use channelstack::{Mode, Result, connect, expect};

#[ignore = "needs a running agent"] // @hide
#[tokio::test]
async fn ships_a_pr_from_a_slack_dm() -> Result<()> {
    let client = connect(Mode::Auto).await?;
    let test_session = client.open_session().send().await?;
    let slack = test_session.slack().await?;
    let ana = slack.create_user().name("ana").await?;
    // [!step 1]
    let msg = ana
        .say("@my-agent ship #812 to staging")
        .to(&slack.app())
        .await?;

    // [!step 2]
    expect(&msg.thread())
        .to_have_status_text("checking CI")
        .await?;
    // [!step 3]
    let ask = msg.thread().wait_for_reply().from("my-agent").await?;
    expect(&ask).to_have_button("Approve").await?;

    // [!step 4]
    ana.click("Approve").message(&ask).await?;
    // [!step 5]
    expect(&msg.thread())
        .to_contain_text("Deployed")
        .count(1)
        .await?;
    expect(&msg.thread())
        .not_to_contain_text("Thinking…")
        .await?;

    test_session.close().await
}
// @show:end
