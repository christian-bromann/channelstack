//! The fake OpenAI from Rust (exit checks 13.4 and 13.6): a responder answers each call from its
//! request, and `firstToken` holds while it is slow; a responder that panics or never answers, a
//! list that runs out, a turn the real API can't give and a call no script answers each fail a
//! waiting check at once and the session's close, with why. The tests play the agent themselves,
//! calling the fake as the official SDKs do (`openai_agent.rs` runs the reference agent). `pnpm
//! test:rust` sets the binary; without it, each test says so and passes.

use std::time::{Duration, Instant};

use channelstack::{Error, Mode, OpenAIFixture, Session, connect, expect};
use serde_json::{Value, json};

/// A Chat Completions call as an agent makes it, tagged with the session (`user`) so it is the test's.
async fn ask(base: &str, key: &str, session: &str, text: &str) -> reqwest::Result<(u16, Value)> {
    ask_offering(base, key, session, text, &[]).await
}

/// `ask`, offering the model these tools.
async fn ask_offering(
    base: &str,
    key: &str,
    session: &str,
    text: &str,
    tools: &[&str],
) -> reqwest::Result<(u16, Value)> {
    let mut body = json!({ "model": "gpt-5", "user": session, "messages": [{ "role": "user", "content": text }] });
    if !tools.is_empty() {
        body["tools"] = tools
            .iter()
            .map(|name| json!({ "type": "function", "function": { "name": name, "parameters": { "type": "object" } } }))
            .collect();
    }
    let response = reqwest::Client::new()
        .post(format!("{base}/chat/completions"))
        .bearer_auth(key)
        .json(&body)
        .send()
        .await?;
    let status = response.status().as_u16();
    Ok((status, response.json().await?))
}

/// Whether the server binary is set; when it isn't, the test says so and passes.
fn has_server() -> bool {
    let set = std::env::var("CHANNELSTACK_SERVER_BIN").is_ok();
    if !set {
        eprintln!("skipped: set CHANNELSTACK_SERVER_BIN (pnpm test:rust does)");
    }
    set
}

/// What no call here ever sends: a check on it waits until its timeout, unless a model problem stops it.
const NEVER_SENT: &str = "words this agent never sends to the model";

/// A waiting check on a session whose model calls went wrong fails within a second, not at its
/// 20s timeout, with `reason`; and the session's close fails with it too.
async fn fails_at_once_and_at_close(
    session: Session,
    openai: &OpenAIFixture,
    reason: &str,
) -> channelstack::Result<()> {
    let started = Instant::now();
    match expect(openai).to_have_sent(NEVER_SENT).timeout("20s").await {
        Err(Error::Expectation(message)) => {
            assert!(message.contains("went wrong"), "{message}");
            assert!(message.contains(reason), "{message}");
        }
        other => panic!("expected the check to fail with the model problem, got {other:?}"),
    }
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "the check gave up after {:?}",
        started.elapsed()
    );
    match session.close().await {
        Err(Error::Expectation(message)) => assert!(message.contains(reason), "{message}"),
        other => panic!("expected the close to fail with the model problems, got {other:?}"),
    }
    Ok(())
}

#[tokio::test]
async fn a_responder_answers_from_the_request() -> channelstack::Result<()> {
    if !has_server() {
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

#[tokio::test]
async fn every_model_problem_fails_a_waiting_check_at_once_and_the_sessions_close()
-> channelstack::Result<()> {
    if !has_server() {
        return Ok(());
    }
    let client = connect(Mode::Start).await?;
    let env = client.env().await?;
    let key = env["OPENAI_API_KEY"]
        .as_str()
        .unwrap_or_default()
        .to_owned();

    // No script answers the call.
    let session = client.open_session().await?;
    let openai = session.openai().await?;
    let (status, _) = ask(
        &openai.base_url(),
        &key,
        &session.session_id(),
        "what broke yesterday?",
    )
    .await
    .expect("the fake answers");
    assert_eq!(status, 400);
    fails_at_once_and_at_close(
        session,
        &openai,
        "no openai.respond(…) in this test answers this call",
    )
    .await?;

    // A list that runs out.
    let session = client.open_session().await?;
    let openai = session.openai().await?;
    openai.respond(json!(["The only answer."])).await?;
    let id = session.session_id();
    let (first, _) = ask(&openai.base_url(), &key, &id, "what broke yesterday?")
        .await
        .expect("the fake answers");
    let (second, _) = ask(&openai.base_url(), &key, &id, "and the day before?")
        .await
        .expect("the fake answers");
    assert_eq!((first, second), (200, 400));
    fails_at_once_and_at_close(session, &openai, "has 1 turn; call 2 arrived").await?;

    // A responder that panics.
    let session = client.open_session().await?;
    let openai = session.openai().await?;
    openai
        .respond_with(|_: Value| async move { panic!("no incident data in this fixture") as Value })
        .await?;
    let (status, _) = ask(
        &openai.base_url(),
        &key,
        &session.session_id(),
        "what broke yesterday?",
    )
    .await
    .expect("the fake answers");
    assert_eq!(status, 400);
    fails_at_once_and_at_close(session, &openai, "no incident data in this fixture").await?;

    // A turn the real API can't give: a tool the request doesn't offer.
    let session = client.open_session().await?;
    let openai = session.openai().await?;
    openai
        .respond(json!({ "toolCalls": [{ "name": "search_incidents", "arguments": { "since": "yesterday" } }] }))
        .await?;
    let (status, _) = ask_offering(
        &openai.base_url(),
        &key,
        &session.session_id(),
        "what broke yesterday?",
        &["lookup_runbook"],
    )
    .await
    .expect("the fake answers");
    assert_eq!(status, 400);
    fails_at_once_and_at_close(
        session,
        &openai,
        "called `search_incidents`, but the request offered `lookup_runbook`",
    )
    .await
}

#[tokio::test]
async fn a_responder_that_never_answers_fails_the_session_with_why() -> channelstack::Result<()> {
    if !has_server() {
        return Ok(());
    }
    let client = connect(Mode::Start).await?;
    let env = client.env().await?;
    let key = env["OPENAI_API_KEY"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let session = client.open_session().await?;
    let openai = session.openai().await?;
    openai
        .respond_with(|_: Value| async move {
            std::future::pending::<()>().await;
            Value::Null
        })
        .await?;

    // The server gives up on the test's answer after its 10s, and refuses the call.
    let (status, refused) = ask(
        &openai.base_url(),
        &key,
        &session.session_id(),
        "what broke yesterday?",
    )
    .await
    .expect("the fake answers");
    assert_eq!(status, 400, "{refused}");
    assert_eq!(refused["error"]["code"], "channelstack_no_script");
    match session.close().await {
        Err(Error::Expectation(message)) => {
            assert!(
                message.contains("the test didn't answer the model call held for"),
                "{message}"
            );
        }
        other => panic!("expected the close to fail with the model problems, got {other:?}"),
    }
    Ok(())
}

#[tokio::test]
async fn first_token_holds_with_a_slow_responder_it_counts_from_the_calls_arrival()
-> channelstack::Result<()> {
    if !has_server() {
        return Ok(());
    }
    let client = connect(Mode::Start).await?;
    let env = client.env().await?;
    let key = env["OPENAI_API_KEY"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let session = client.open_session().await?;
    let openai = session.openai().await?;
    openai
        .respond_with(|_: Value| async move {
            tokio::time::sleep(Duration::from_millis(800)).await;
            json!({ "text": "Two incidents yesterday.", "timing": { "firstToken": 1500 } })
        })
        .await?;

    let started = Instant::now();
    let (status, answer) = ask(
        &openai.base_url(),
        &key,
        &session.session_id(),
        "what broke yesterday?",
    )
    .await
    .expect("the fake answers");
    let took = started.elapsed();

    assert_eq!(status, 200, "{answer}");
    assert_eq!(
        answer["choices"][0]["message"]["content"],
        "Two incidents yesterday."
    );
    // Not before firstToken, and the responder's time is part of it, not added to it.
    assert!(
        took >= Duration::from_millis(1500) && took < Duration::from_millis(2000),
        "{took:?}"
    );
    session.close().await
}

#[tokio::test]
async fn respond_with_takes_when_times_and_timing_as_respond_does() -> channelstack::Result<()> {
    if !has_server() {
        return Ok(());
    }
    let client = connect(Mode::Start).await?;
    let env = client.env().await?;
    let key = env["OPENAI_API_KEY"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let session = client.open_session().await?;
    let openai = session.openai().await?;
    let id = session.session_id();
    let base = openai.base_url();
    // The responder answers only calls about the deploy, only once, and holds its first token.
    let responder = openai
        .respond_with(|_: Value| async move { json!("The deploy is fine.") })
        .when(json!({ "text": "deploy" }))
        .times(1)
        .timing(json!({ "firstToken": 600 }))
        .await?;
    let rest = openai.respond(json!(["Something else."])).times(-1).await?;

    let started = Instant::now();
    let (_, deploy) = ask(&base, &key, &id, "how did the deploy go?")
        .await
        .expect("the fake answers");
    let took = started.elapsed();
    let (_, other) = ask(&base, &key, &id, "and the DNS blip?")
        .await
        .expect("the fake answers");
    let (_, again) = ask(&base, &key, &id, "the deploy again?")
        .await
        .expect("the fake answers");

    assert_eq!(
        deploy["choices"][0]["message"]["content"],
        "The deploy is fine."
    );
    assert!(took >= Duration::from_millis(600), "{took:?}");
    // `when` left this call to the next script.
    assert_eq!(other["choices"][0]["message"]["content"], "Something else.");
    // `times(1)`: the responder answered once; the next script took the second call about the deploy.
    assert_eq!(again["choices"][0]["message"]["content"], "Something else.");
    expect(&responder).to_have_answered().times(1).await?;
    expect(&rest).to_have_answered().times(2).await?;
    session.close().await
}
