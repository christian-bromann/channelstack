use channelstack::{Handle, Result};
use serde_json::json;

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn people_act_resources_are_read() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let github = session.github().await?;
    let linear = session.linear().await?;
    let notion = session.notion().await?;
    let ana = slack.create_user().name("Ana").await?;
    let ben = slack.create_user().name("Ben").admin(true).await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &ben, &slack.app()])
        .await?;
    let asked = ana
        .say("@my-agent deploy web to staging")
        .channel(&channel)
        .await?;
    let reply = asked.thread().latest_reply().from("my-agent").await?;
    let cara = github.create_user().login("cara").await?;
    let repo = github
        .create_repo()
        .collaborators(vec![&cara as &dyn Handle])
        .apps(vec![&github.app()])
        .await?;
    let pr = cara
        .open_pull_request(json!({
            "from": "fix-login",
            "changes": { "src/login.ts": "export {};\n" },
        }))
        .repo(&repo)
        .await?;
    let dev = linear.create_user().name("Dev").await?;
    let team = linear.create_team().members(vec![&dev]).await?;
    let issue = dev
        .create_issue(json!({ "title": "Checkout fails on Safari" }))
        .team(&team)
        .await?;
    let eve = notion.create_user().name("Eve").await?;
    let page = notion
        .create_page()
        .title("Roadmap")
        .connections(vec![&notion.app()])
        .await?;
    let discussion = eve
        .comment("@my-agent summarize this page")
        .page(&page)
        .await?
        .discussion();
    // @show:start
    ana.say("@my-agent deploy web").channel(&channel).await?;
    ben.click("Approve").message(&reply).await?;
    cara.comment("@my-agent fix this").issue(&pr).await?;
    dev.delegate(&linear.app()).issue(&issue).await?;
    eve.reply("thanks!").discussion(&discussion).await?;
    // @show:end
    session.close().await
}
