use channelstack::{Regex, Result, expect};
use serde_json::json;

use crate::fixtures;

// @show:start
#[tokio::test]
#[ignore = "needs a running agent"]
async fn streams_the_answer_into_the_dm_and_the_status_clears() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let openai = session.openai().await?;
    openai
        .respond(json!({ "text": ["The web deploy", " failed at", " the migration", " step."] }))
        .timing(json!({ "firstToken": "700ms", "betweenChunks": "250ms" }))
        .await?;
    let ana = slack.create_user().name("Ana").await?;
    let msg = ana.say("why did the deploy fail?").to(&slack.app()).await?;

    expect(&msg.thread()).to_have_status("working").await?;
    expect(&msg.thread())
        .to_have_status_text(Regex::new("(?i)thinking")?)
        .await?;
    expect(&msg.thread())
        .to_have_streaming_reply_from("my-agent")
        .await?;
    expect(&msg.thread()).to_have_status("idle").await?;
    expect(&msg.thread())
        .to_have_reply_from("my-agent")
        .text(Regex::new("failed at the migration step")?)
        .await?;
    expect(&openai).to_have_sent(msg.text()).await?;
    session.close().await
}

#[tokio::test]
#[ignore = "needs a running agent"]
async fn the_agent_runs_the_tool_the_model_calls_and_answers_from_its_result() -> Result<()> {
    let session = fixtures::session().await?;
    let slack = session.slack().await?;
    let openai = session.openai().await?;
    let ai = openai
        .respond(json!([
            { "toolCalls": [{ "name": "search_incidents", "arguments": { "since": "yesterday" } }] },
            "Two incidents yesterday: the web deploy and a DNS blip.",
        ]))
        .await?;
    let ana = slack.create_user().name("Ana").await?;
    let msg = ana.say("what broke yesterday?").to(&slack.app()).await?;

    expect(&msg.thread())
        .to_have_reply_from("my-agent")
        .text(Regex::new("DNS blip")?)
        .await?;
    expect(&msg.thread())
        .to_have_replies_from("my-agent", 1)
        .await?;
    expect(&ai).to_have_answered().times(2).await?;
    expect(&ai)
        .to_have_sent_tool_result("search_incidents")
        .text(Regex::new("migration")?)
        .await?;
    session.close().await
}
// @show:end
