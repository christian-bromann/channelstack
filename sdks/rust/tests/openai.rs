//! The fake OpenAI from Rust (exit check 13.6): a responder answers each call from its request, a
//! responder that panics fails the call with why, and the model's matchers read what was sent.
//! The test plays the agent itself, calling the fake as the official SDKs do. `pnpm test:rust`
//! sets the binary; without it, the test says so and passes.

use channelstack::{Error, Mode, connect, expect};
use serde_json::{Value, json};

/// A Chat Completions call as an agent makes it, tagged with the session (`user`) so it is the test's.
async fn ask(base: &str, key: &str, session: &str, text: &str) -> reqwest::Result<(u16, Value)> {
    let response = reqwest::Client::new()
        .post(format!("{base}/chat/completions"))
        .bearer_auth(key)
        .json(&json!({ "model": "gpt-5", "user": session, "messages": [{ "role": "user", "content": text }] }))
        .send()
        .await?;
    let status = response.status().as_u16();
    Ok((status, response.json().await?))
}

#[tokio::test]
async fn a_responder_answers_from_the_request() -> channelstack::Result<()> {
    if std::env::var("CHANNELSTACK_SERVER_BIN").is_err() {
        eprintln!("skipped: set CHANNELSTACK_SERVER_BIN (pnpm test:rust does)");
        return Ok(());
    }
    let client = connect(Mode::Start).await?;
    let session = client.open_session().await?;
    let env = client.env().await?;
    let key = env["OPENAI_API_KEY"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let openai = session.openai().await?;
    let base = openai.base_url();

    let script = openai
        .respond_with(|request: Value| async move {
            json!(format!(
                "You said: {}",
                request["lastUserText"].as_str().unwrap_or_default()
            ))
        })
        .await?;
    let (status, answer) = ask(&base, &key, &session.session_id(), "how is the web deploy?")
        .await
        .expect("the fake answers");
    assert_eq!(status, 200, "{answer}");
    assert_eq!(
        answer["choices"][0]["message"]["content"],
        "You said: how is the web deploy?"
    );
    expect(&script).to_have_answered().await?;
    expect(&openai)
        .to_have_sent("how is the web deploy?")
        .await?;
    expect(&openai).not_to_have_sent_secrets().await?;
    script.undo().await?;

    // A function that panics is the test's bug: the call is refused, and says why.
    openai
        .respond_with(|_: Value| async move { panic!("boom") as Value })
        .await?;
    let (status, refused) = ask(&base, &key, &session.session_id(), "and the API?")
        .await
        .expect("the fake answers");
    assert_eq!(status, 400, "{refused}");
    assert_eq!(refused["error"]["code"], "channelstack_no_script");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("panicked"),
        "{refused}"
    );
    // The session's model problems fail its close, as the other SDKs fail the test.
    match session.close().await {
        Err(Error::Expectation(message)) => assert!(message.contains("went wrong"), "{message}"),
        other => panic!("expected the close to fail with the model problems, got {other:?}"),
    }
    Ok(())
}
