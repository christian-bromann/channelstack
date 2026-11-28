//! The Rust port of the fake OpenAI's examples (exit check 13.6, `test/acceptance/examples/openai.test.ts`):
//! the reference agent on the official `openai` SDK (`examples/agents/openai-node`) runs a tool loop
//! the test scripts, and answers a person through a responder that reads the call's context. The
//! test starts the server with the agent's Slack endpoint, then the agent with what `env()` prints.
//! `pnpm test:rust` sets the binary; without it, the test says so and passes.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use channelstack::{Handle, Mode, Regex, connect_with, expect};
use serde_json::{Value, json};
use tokio::process::{Child, Command};

/// The repository's root, where the reference agents live.
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// A loopback port nothing listens on yet.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .expect("a free port")
}

/// Wait until `ready` answers, for at most 20s.
async fn until<F, Fut, T>(what: &str, ready: F) -> T
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let started = Instant::now();
    loop {
        if let Some(value) = ready().await {
            return value;
        }
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "{what} didn't start within 20s"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The server, with the agent's Slack endpoint, and the reference agent on the official SDK.
struct Stack {
    server: Child,
    agent: Child,
    url: String,
    token: String,
    _home: tempfile::TempDir,
}

impl Stack {
    async fn start(binary: &str) -> Stack {
        let home = tempfile::tempdir().expect("a private directory");
        let port = free_port();
        let server_file = home.path().join("server.json");
        let server = Command::new(binary)
            .args(["start", "--no-portless", "--port", "0", "--server-file"])
            .arg(&server_file)
            .env("CHANNELSTACK_HOME", home.path())
            .env("CHANNELSTACK_LOG_LEVEL", "warn")
            .env(
                "CHANNELSTACK_SLACK_WEBHOOK_URL",
                format!("http://127.0.0.1:{port}/slack/events"),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("the server starts");
        let (url, token) = until("the server", || async {
            let data: Value =
                serde_json::from_str(&std::fs::read_to_string(&server_file).ok()?).ok()?;
            Some((
                data["url"].as_str()?.to_owned(),
                data["token"].as_str()?.to_owned(),
            ))
        })
        .await;
        let client = until("the control API", || async {
            connect_with(Mode::Attach, Some(&url), Some(&token))
                .await
                .ok()
        })
        .await;
        let env = client.env().await.expect("the agent's environment");
        let mut agent = Command::new("node");
        agent
            .arg(root().join("examples/agents/openai-node/agent.ts"))
            .current_dir(root())
            .env("PORT", port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .kill_on_drop(true);
        for (name, value) in env.as_object().into_iter().flatten() {
            if let Some(value) = value.as_str() {
                agent.env(name, value);
            }
        }
        let agent = agent.spawn().expect("the agent starts");
        until("the agent", || async {
            tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .ok()
                .map(|_| ())
        })
        .await;
        Stack {
            server,
            agent,
            url,
            token,
            _home: home,
        }
    }

    async fn stop(mut self) {
        let _ = self.agent.kill().await;
        let _ = self.server.kill().await;
    }
}

#[tokio::test]
async fn the_reference_agent_runs_a_scripted_tool_loop_and_a_responder_answers_from_its_context()
-> channelstack::Result<()> {
    let Ok(binary) = std::env::var("CHANNELSTACK_SERVER_BIN") else {
        eprintln!("skipped: set CHANNELSTACK_SERVER_BIN (pnpm test:rust does)");
        return Ok(());
    };
    let stack = Stack::start(&binary).await;
    let client = connect_with(Mode::Attach, Some(&stack.url), Some(&stack.token)).await?;

    // A tool loop ends in one answer, in the thread.
    let session = client.open_session().await?;
    let slack = session.slack().await?;
    let openai = session.openai().await?;
    let ana = slack.create_user().name("Ana").await?;
    let channel = slack
        .create_channel()
        .participants(vec![&ana as &dyn Handle, &slack.app()])
        .await?;
    let ai = openai
        .respond(json!([
            { "toolCalls": [{ "name": "search_incidents", "arguments": { "since": "yesterday" } }] },
            "Two incidents yesterday: the web deploy and a DNS blip.",
        ]))
        .await?;

    let msg = ana
        .say("@my-agent what broke yesterday?")
        .channel(&channel)
        .await?;

    expect(&msg.thread())
        .to_have_reply_from("my-agent")
        .text(Regex::new("DNS blip")?)
        .await?;
    expect(&msg.thread())
        .to_have_replies_from("my-agent", 1)
        .await?;
    expect(&ai).to_have_answered().times(2).await?;
    // The agent ran the tool and sent the result back.
    expect(&ai)
        .to_have_sent_tool_result("search_incidents")
        .text(Regex::new("migration")?)
        .await?;
    session.close().await?;

    // A responder answers each person from the call's context: who wrote the message it answers.
    let session = client.open_session().await?;
    let slack = session.slack().await?;
    let openai = session.openai().await?;
    let ana = slack.create_user().name("Ana").await?;
    let ben = slack.create_user().name("Ben").await?;
    let ana_id = ana.id();
    openai
        .respond_with(move |request: Value| {
            let ana_id = ana_id.clone();
            async move {
                let asker = if request["context"]["from"]["id"] == ana_id.as_str() {
                    "Ana"
                } else {
                    "someone else"
                };
                json!(format!(
                    "Hello {asker}, about \"{}\".",
                    request["lastUserText"].as_str().unwrap_or_default()
                ))
            }
        })
        .await?;

    let from_ana = ana.say("is the web deploy green?").to(&slack.app()).await?;
    let from_ben = ben
        .say("did the migration finish?")
        .to(&slack.app())
        .await?;

    expect(&from_ana.thread())
        .to_have_reply_from("my-agent")
        .text(Regex::new("^Hello Ana, about .*web deploy")?)
        .await?;
    expect(&from_ben.thread())
        .to_have_reply_from("my-agent")
        .text(Regex::new("^Hello someone else, about .*migration")?)
        .await?;
    session.close().await?;

    stack.stop().await;
    Ok(())
}
