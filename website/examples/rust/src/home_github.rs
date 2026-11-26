//! The home page's GitHub example (website/samples/github.test.ts), in Rust.
// @show:start
use channelstack::{Handle, Mode, Result, connect, expect};
use serde_json::json;

#[ignore = "needs a running agent"] // @hide
#[tokio::test]
async fn answers_on_the_issue_and_ignores_itself() -> Result<()> {
    let client = connect(Mode::Auto).await?;
    let test_session = client.open_session().send().await?;
    let github = test_session.github().await?;
    let mo = github.create_user().login("mo").await?;
    let repo = github
        .create_repo()
        .collaborators(vec![&mo as &dyn Handle])
        .apps(vec![&github.app()])
        .await?;
    // [!step 1]
    let issue = mo
        .open_issue(json!({ "title": "Login 500s on Safari" }))
        .repo(&repo)
        .await?;

    // [!step 2]
    let comment = mo
        .comment("@my-agent can you take a look?")
        .issue(&issue)
        .await?;
    // [!step 3]
    expect(&issue)
        .to_have_comment_from("my-agent")
        .text("Safari")
        .await?;

    // the same delivery again must not start a second run
    // [!step 4]
    comment.delivery().expect("a delivery").redeliver().await?;
    // [!step 5]
    expect(&issue).to_have_comments_from("my-agent", 1).await?;

    test_session.close().await
}
// @show:end
