//! The home page's Linear example (website/samples/linear.test.ts), in Rust.
// @show:start
use channelstack::{Mode, Result, connect, expect};
use serde_json::json;

#[ignore = "needs a running agent"] // @hide
#[tokio::test]
async fn stop_ends_a_working_session() -> Result<()> {
    let client = connect(Mode::Auto).await?;
    let test_session = client.open_session().send().await?;
    let linear = test_session.linear().await?;
    let kai = linear.create_user().name("Kai").await?;
    let team = linear.create_team().key("ENG").members(vec![&kai]).await?;
    // [!step 1]
    let issue = kai
        .create_issue(json!({ "title": "Migrate billing cron" }))
        .team(&team)
        .await?;

    // [!step 2]
    let session = kai.delegate(&linear.app()).issue(&issue).await?;
    // [!step 3]
    expect(&session)
        .to_have_activity()
        .r#type("thought")
        .await?;

    // [!step 4]
    kai.stop().session(&session).await?;
    // [!step 5]
    expect(&session).to_have_session_state("complete").await?;

    test_session.close().await
}
// @show:end
