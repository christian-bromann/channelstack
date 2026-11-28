//! The home page's model example (website/samples/openai.test.ts), in Rust.
// @show:start
use channelstack::{Handle, Mode, Regex, Result, connect, expect};
use serde_json::json;

#[ignore = "needs a running agent"] // @hide
#[tokio::test]
async fn answers_from_a_tool_call_once() -> Result<()> {
    let client = connect(Mode::Auto).await?;
    let test_session = client.open_session().send().await?;
    let slack = test_session.slack().await?;
    let openai = test_session.openai().await?;
    let ana = slack.create_user().name("Ana").await?;
    let channel = slack
        .create_channel()
        .name("ops")
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;
    let ai = openai
        .respond(json!([
            { "toolCalls": [{ "name": "search_incidents", "arguments": { "since": "yesterday" } }] },
            "Two incidents yesterday: the web deploy and a DNS blip.",
        ]))
        .await?;
    // [!step 1]
    let msg = ana
        .say("@my-agent what broke yesterday?")
        .channel(&channel)
        .await?;

    // [!step 2]
    expect(&ai).to_have_offered_tool("search_incidents").await?;
    // [!step 3]
    expect(&ai)
        .to_have_sent_tool_result("search_incidents")
        .text(Regex::new("migration")?)
        .await?;
    // [!step 4]
    expect(&msg.thread())
        .to_have_reply_from("my-agent")
        .text(Regex::new("DNS blip")?)
        .await?;
    // [!step 5]
    expect(&msg.thread())
        .to_have_replies_from("my-agent", 1)
        .await?;
    expect(&ai).to_have_answered().times(2).await?;
    expect(&openai).not_to_have_sent_secrets().await?;

    test_session.close().await
}
// @show:end
