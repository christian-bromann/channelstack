use channelstack::{Handle, Result};

use crate::fixtures;

#[tokio::test]
#[ignore = "needs a running agent"]
async fn the_agents_split_view() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let ana = slack.create_user().name("Ana").await?;
    let incidents = slack
        .create_channel()
        .name("incidents")
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;
    let general = slack
        .create_channel()
        .name("general")
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;
    // @show:start
    let thread = ana.open_agent_thread().from(&incidents).await?;
    let prompts = thread.suggested_prompts().await?;

    ana.pick_prompt("What changed?").thread(&thread).await?;
    ana.switch_context(&general).thread(&thread).await?;
    ana.reply("summarize this channel").thread(&thread).await?;
    // @show:end
    let _ = prompts;
    session.close().await
}
