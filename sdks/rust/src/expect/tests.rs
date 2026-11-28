//! `expect(…)` passes and fails the way matchers-core does, on stand-in subjects (no server).

use std::sync::Mutex;

use serde_json::{Value, json};

use super::expect;
use super::subjects::*;
use crate::Regex;
use crate::runtime::client::BoxFuture;
use crate::runtime::error::{Error, Result};
use crate::runtime::wait::QuietState;

/// A subject of every kind: each read answers its field of `data`. What `said` reads gains one of
/// `later` on each read, so a positive check sees it arrive.
#[derive(Default)]
struct StandIn {
    data: Value,
    later: Mutex<Vec<Value>>,
    said: Mutex<Vec<Value>>,
    /// What the session says the agent left open.
    open: Vec<String>,
    /// The bot loops the session says the fake stopped.
    loops: Vec<String>,
    /// The `error` the last read of the calls filtered by.
    filtered_by: Mutex<Value>,
    /// The windows the model's reads were asked for.
    asked: Mutex<Vec<u64>>,
}

impl StandIn {
    fn with(data: Value) -> Self {
        Self {
            data,
            ..Self::default()
        }
    }
    fn saying(said: Vec<Value>) -> Self {
        Self {
            said: Mutex::new(said),
            ..Self::default()
        }
    }
    fn answer(&self, read: &str) -> BoxFuture<'_, Result<Value>> {
        let value = self.data.get(read).cloned().unwrap_or(Value::Null);
        Box::pin(async move { Ok(value) })
    }
}

impl Subject for StandIn {
    /// Always quiet for a minute, with what is open.
    fn quiet(&self) -> BoxFuture<'_, Result<QuietState>> {
        let (open, loops) = (self.open.clone(), self.loops.clone());
        Box::pin(async move {
            Ok(QuietState {
                busy: false,
                quiet_for_ms: 60_000.0,
                open,
                problems: vec![],
                loops,
            })
        })
    }

    /// `unattributed` and `sessionCalls`, and the window asked for in `asked`.
    fn model_reads(&self, within_ms: u64) -> BoxFuture<'_, Result<(Value, Value)>> {
        self.asked.lock().unwrap().push(within_ms);
        let reads = (
            self.data["unattributed"].clone(),
            self.data["sessionCalls"].clone(),
        );
        Box::pin(async move { Ok(reads) })
    }
}

impl ScriptRefresh for StandIn {
    fn read_script(&self) -> BoxFuture<'_, Result<Value>> {
        self.answer("script")
    }
}

impl ModelCalls for StandIn {
    fn read_model_calls(&self) -> BoxFuture<'_, Result<Value>> {
        self.answer("modelCalls")
    }
}

impl Said for StandIn {
    fn read_said(&self) -> BoxFuture<'_, Result<Value>> {
        let mut said = self.said.lock().unwrap();
        let mut later = self.later.lock().unwrap();
        if !later.is_empty() {
            said.push(later.remove(0));
        }
        let value = Value::Array(said.clone());
        Box::pin(async move { Ok(value) })
    }
}

macro_rules! answers {
    ($($trait:ident :: $read:ident => $field:literal),+ $(,)?) => {$(
        impl $trait for StandIn {
            fn $read(&self) -> BoxFuture<'_, Result<Value>> {
                self.answer($field)
            }
        }
    )+};
}
answers!(
    ChannelMessages::read_messages => "messages",
    Status::read_status => "status",
    Reactions::read_reactions => "reactions",
    Modals::read_modals => "modals",
    Comments::read_comments => "comments",
    CheckRuns::read_check_runs => "checkRuns",
    Labels::read_labels => "labels",
);

impl Readable for StandIn {
    /// As `as` sees it: `transcriptAs` when a viewer is given.
    fn read_transcript(&self, viewer: Value) -> BoxFuture<'_, Result<Value>> {
        self.answer(if viewer.is_null() {
            "transcript"
        } else {
            "transcriptAs"
        })
    }
}

impl Buttons for StandIn {
    fn read_entries(&self) -> BoxFuture<'_, Result<Value>> {
        self.answer("entries")
    }
    fn entry_id(&self) -> Option<String> {
        self.data["entryId"].as_str().map(str::to_owned)
    }
}

impl Ephemeral for StandIn {
    fn visible_to(&self) -> Value {
        self.data["visibleTo"].clone()
    }
}

impl PullRequest for StandIn {
    fn read_review_comments(&self) -> BoxFuture<'_, Result<Value>> {
        self.answer("reviewComments")
    }
    fn read_reviews(&self) -> BoxFuture<'_, Result<Value>> {
        self.answer("reviews")
    }
    fn read_merged(&self) -> BoxFuture<'_, Result<Value>> {
        self.answer("merged")
    }
}

impl AgentSession for StandIn {
    fn read_session_state(&self) -> BoxFuture<'_, Result<Value>> {
        self.answer("sessionState")
    }
    fn read_activities(&self) -> BoxFuture<'_, Result<Value>> {
        self.answer("activities")
    }
}

impl Issue for StandIn {
    fn read_delegate(&self) -> BoxFuture<'_, Result<Value>> {
        self.answer("delegate")
    }
    fn read_assignee(&self) -> BoxFuture<'_, Result<Value>> {
        self.answer("assignee")
    }
    fn read_workflow_state(&self) -> BoxFuture<'_, Result<Value>> {
        self.answer("state")
    }
}

impl Page for StandIn {
    fn read_blocks(&self) -> BoxFuture<'_, Result<Value>> {
        self.answer("blocks")
    }
    fn read_property(&self, name: &str) -> BoxFuture<'_, Result<Value>> {
        let value = self.data["properties"][name].clone();
        Box::pin(async move { Ok(value) })
    }
}

impl Delivery for StandIn {
    fn delivery_id(&self) -> String {
        "D1".into()
    }
    fn read_attempts(&self) -> BoxFuture<'_, Result<Value>> {
        self.answer("attempts")
    }
}

impl Calls for StandIn {
    fn read_calls(&self, error: Value) -> BoxFuture<'_, Result<Value>> {
        *self.filtered_by.lock().unwrap() = error.clone();
        let calls = self.data["calls"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|call| error.is_null() || call["error"] == error)
            .collect();
        Box::pin(async move { Ok(Value::Array(calls)) })
    }
}

fn agent() -> Value {
    json!({ "id": "B01", "name": "my-agent", "kind": "app" })
}
fn ana() -> Value {
    json!({ "id": "U01", "name": "Ana", "kind": "user" })
}
fn says(author: Value, text: &str) -> Value {
    json!({ "author": author, "text": text })
}

/// The message of a failed check.
fn failure(result: Result<()>) -> String {
    match result {
        Err(Error::Expectation(message)) => message,
        other => panic!("expected a failed check, got {other:?}"),
    }
}

const FAST: &str = "300ms";
const QUIET: &str = "20ms";

#[tokio::test]
async fn a_positive_check_waits_for_what_arrives_later() -> Result<()> {
    let thread = StandIn::default();
    *thread.later.lock().unwrap() = vec![says(ana(), "hi"), says(agent(), "an incident report")];
    expect(&thread)
        .to_have_reply_from("my-agent")
        .text(Regex::new("(?i)INCIDENT")?)
        .timeout(FAST)
        .await?;
    // A handle's data matches by id.
    expect(&thread).to_have_reply_from(agent()).await
}

#[tokio::test]
async fn a_positive_check_fails_with_what_the_thread_has() {
    let thread = StandIn::saying(vec![says(ana(), "hi")]);
    let failed = failure(
        expect(&thread)
            .to_have_reply_from("my-agent")
            .text("report")
            .timeout(FAST)
            .await,
    );
    assert_eq!(
        failed,
        "Expected a reply from my-agent matching \"report\". The thread has:\n  Ana: hi"
    );
}

#[tokio::test]
async fn a_negative_check_fails_on_a_reply() -> Result<()> {
    let thread = StandIn::saying(vec![says(agent(), "here")]);
    let failed = failure(
        expect(&thread)
            .not_to_have_reply_from("my-agent")
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected no reply from my-agent. The thread has:\n  my-agent: here"
    );
    let quiet = StandIn::saying(vec![says(ana(), "hi")]);
    expect(&quiet)
        .not_to_have_reply_from("my-agent")
        .quiet_for(QUIET)
        .await
}

#[tokio::test]
async fn a_negative_check_watches_the_whole_quiet_window() -> Result<()> {
    let thread = StandIn::default();
    let started = std::time::Instant::now();
    expect(&thread)
        .not_to_have_reply_from("my-agent")
        .quiet_for("80ms")
        .await?;
    // The session has been quiet for a minute, and still the check looked for 80ms.
    assert!(started.elapsed() >= std::time::Duration::from_millis(80));
    Ok(())
}

#[tokio::test]
async fn an_exact_count_is_checked_once_quiet() -> Result<()> {
    let thread = StandIn::saying(vec![says(agent(), "one"), says(agent(), "two")]);
    expect(&thread)
        .to_have_replies_from("my-agent", 2)
        .quiet_for(QUIET)
        .await?;
    let failed = failure(
        expect(&thread)
            .to_have_replies_from("my-agent", 1)
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected exactly 1 reply from my-agent, found 2:\n  my-agent: one\n  my-agent: two"
    );
    let failed = failure(
        expect(&thread)
            .not_to_have_replies_from("my-agent", 2)
            .quiet_for(QUIET)
            .await,
    );
    assert!(
        failed.starts_with("Expected not exactly 2 replies from my-agent, found 2"),
        "{failed}"
    );
    Ok(())
}

#[tokio::test]
async fn a_failure_says_what_the_agent_left_open() {
    let thread = StandIn {
        open: vec!["a stream my-agent never stopped".into()],
        ..StandIn::saying(vec![says(ana(), "hi")])
    };
    let failed = failure(
        expect(&thread)
            .to_have_reply_from("my-agent")
            .timeout(FAST)
            .await,
    );
    assert!(
        failed.ends_with("  Ana: hi\nStill open: a stream my-agent never stopped"),
        "{failed}"
    );
}

#[tokio::test]
async fn a_failure_prints_as_its_message() {
    let thread = StandIn::saying(vec![says(ana(), "hi")]);
    let error = expect(&thread)
        .to_have_reply_from("my-agent")
        .timeout(FAST)
        .await
        .unwrap_err();
    // What a test that returns `Result` prints: the lines as they are, not escaped.
    assert_eq!(
        format!("{error:?}"),
        "Expected a reply from my-agent. The thread has:\n  Ana: hi"
    );
}

#[tokio::test]
async fn a_pattern_rust_cant_use_is_refused_before_the_check_starts() {
    let thread = StandIn::default();
    let refused = expect(&thread)
        .to_have_reply_from("my-agent")
        .text(json!({ "source": "a(?=b)", "flags": "" }))
        .await;
    assert!(matches!(refused, Err(Error::Invalid(_))), "{refused:?}");
}

#[tokio::test]
async fn channel_messages_and_streams() -> Result<()> {
    let channel = StandIn::with(json!({ "messages": [says(ana(), "hi")] }));
    expect(&channel)
        .not_to_have_channel_message_from("my-agent")
        .quiet_for(QUIET)
        .await?;
    let failed = failure(
        expect(&channel)
            .to_have_channel_message_from("my-agent")
            .timeout(FAST)
            .await,
    );
    assert_eq!(
        failed,
        "Expected a message from my-agent in the channel itself, found none"
    );
    let failed = failure(
        expect(&channel)
            .not_to_have_channel_message_from("Ana")
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected no message from Ana in the channel itself, found:\n  Ana: hi"
    );

    let mut streamed = says(agent(), "Deploying");
    streamed["stream"] = json!({ "state": "open" });
    let thread = StandIn::saying(vec![says(ana(), "deploy"), streamed]);
    expect(&thread)
        .to_have_streaming_reply_from("my-agent")
        .await?;
    expect(&thread)
        .to_have_streaming_reply_from(Value::Null)
        .await?;
    let failed = failure(
        expect(&thread)
            .not_to_have_streaming_reply_from(Value::Null)
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected no reply being streamed. The thread has:\n  Ana: deploy [not a stream]\n  my-agent: Deploying [open]"
    );
    Ok(())
}

#[tokio::test]
async fn text_a_person_sees_once_or_exactly_n_times() -> Result<()> {
    let transcript = json!({ "entries": [
        says(ana(), "Rate limits?"),
        says(agent(), "Rate limits are 50 per minute"),
    ] });
    let thread = StandIn::with(json!({
        "transcript": transcript,
        "transcriptAs": { "entries": [says(agent(), "only you can see this")] },
    }));
    expect(&thread).to_contain_text("50 per minute").await?;
    expect(&thread)
        .to_contain_text(Regex::new("(?i)rate limits")?)
        .count(2)
        .quiet_for(QUIET)
        .await?;
    expect(&thread)
        .to_contain_text("Rate limits")
        .from("my-agent")
        .count(1)
        .quiet_for(QUIET)
        .await?;
    expect(&thread)
        .to_contain_text("only you")
        .r#as(ana())
        .await?;
    let failed = failure(
        expect(&thread)
            .to_contain_text("Rate limits")
            .count(1)
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected exactly 1 entries with text matching \"Rate limits\", found 2. A person sees:\n  Ana: Rate limits?\n  my-agent: Rate limits are 50 per minute"
    );
    let failed = failure(
        expect(&thread)
            .not_to_contain_text(Regex::new("per minute")?)
            .quiet_for(QUIET)
            .await,
    );
    assert!(
        failed.starts_with("Expected no text matching /per minute/, found 1."),
        "{failed}"
    );
    Ok(())
}

#[tokio::test]
async fn status_and_its_line() -> Result<()> {
    let thread =
        StandIn::with(json!({ "status": { "state": "working", "text": "Deploying web" } }));
    expect(&thread).to_have_status("working").await?;
    expect(&thread).to_have_status_text("web").await?;
    let failed = failure(expect(&thread).to_have_status("idle").timeout(FAST).await);
    assert_eq!(
        failed,
        "Expected the thread to be idle, it is working (\"Deploying web\")"
    );
    let failed = failure(
        expect(&thread)
            .not_to_have_status_text(Regex::new("^Deploying")?)
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected the status line not to match /^Deploying/, it is \"Deploying web\""
    );
    let idle = StandIn::with(json!({ "status": { "state": "idle" } }));
    let failed = failure(expect(&idle).to_have_status_text("x").timeout(FAST).await);
    assert_eq!(
        failed,
        "Expected the status line to match \"x\", there is none"
    );
    expect(&thread)
        .not_to_have_status("idle")
        .quiet_for(QUIET)
        .await?;
    let failed = failure(
        expect(&thread)
            .not_to_have_status("working")
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected the thread not to be working, it is working (\"Deploying web\")"
    );
    Ok(())
}

#[tokio::test]
async fn a_button_on_a_message_or_the_apps_latest_one() -> Result<()> {
    let entries = json!([
        { "id": "1.1", "author": agent(), "text": "Deploy?", "controls": ["Approve", "Reject"] },
        { "id": "1.2", "author": ana(), "text": "hm", "controls": ["Mine"] },
        { "id": "1.3", "author": agent(), "text": "Sure?", "controls": ["Yes"] },
    ]);
    let thread = StandIn::with(json!({ "entries": entries }));
    expect(&thread).to_have_button("Yes").await?;
    let failed = failure(
        expect(&thread)
            .to_have_button("Approve")
            .timeout(FAST)
            .await,
    );
    assert_eq!(
        failed,
        "Expected a button matching \"Approve\". Buttons there: Yes"
    );
    let message = StandIn::with(json!({ "entries": entries, "entryId": "1.1" }));
    expect(&message)
        .to_have_button(Regex::new("^Appr")?)
        .await?;
    expect(&message)
        .not_to_have_button("Yes")
        .quiet_for(QUIET)
        .await
}

#[tokio::test]
async fn a_reaction_a_modal_and_who_can_see_a_message() -> Result<()> {
    let message = StandIn::with(json!({
        "reactions": [{ "emoji": "eyes", "by": [ana()] }],
        "modals": [{ "title": "Deploy web" }],
        "visibleTo": ana(),
    }));
    expect(&message).to_have_reaction(":eyes:").await?;
    expect(&message).to_have_reaction("eyes").by("Ana").await?;
    let failed = failure(
        expect(&message)
            .to_have_reaction("eyes")
            .by(agent())
            .timeout(FAST)
            .await,
    );
    assert_eq!(
        failed,
        "Expected a :eyes: reaction by my-agent. Reactions there: :eyes: by Ana"
    );
    expect(&message)
        .not_to_have_reaction("eyes")
        .by(agent())
        .quiet_for(QUIET)
        .await?;
    let failed = failure(
        expect(&message)
            .not_to_have_reaction(":eyes:")
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected no :eyes: reaction. Reactions there: :eyes: by Ana"
    );

    expect(&message).to_have_opened_modal("Deploy").await?;
    expect(&message).to_have_opened_modal(Value::Null).await?;
    let failed = failure(
        expect(&message)
            .not_to_have_opened_modal(Value::Null)
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected no modal to have been opened. Opened: \"Deploy web\""
    );

    expect(&message).to_be_ephemeral_for(ana()).await?;
    let failed = failure(expect(&message).to_be_ephemeral_for(agent()).await);
    assert_eq!(
        failed,
        "Expected the message to be visible only to my-agent, only Ana can"
    );
    let everyone = StandIn::default();
    let failed = failure(expect(&everyone).to_be_ephemeral_for(ana()).await);
    assert_eq!(
        failed,
        "Expected the message to be visible only to Ana, everyone can see it"
    );
    expect(&everyone).not_to_be_ephemeral_for(ana()).await
}

#[tokio::test]
async fn comments_from_someone_and_exactly_how_many() -> Result<()> {
    // GitHub and Linear call a comment's text `body`, Notion `text`.
    let issue = StandIn::with(json!({ "comments": [
        { "author": ana(), "body": "@my-agent triage" },
        { "author": agent(), "body": "Labelled bug" },
    ] }));
    expect(&issue)
        .to_have_comment_from("my-agent")
        .text("bug")
        .await?;
    expect(&issue)
        .to_have_comments_from("my-agent", 1)
        .quiet_for(QUIET)
        .await?;
    let failed = failure(
        expect(&issue)
            .to_have_comments_from("my-agent", 2)
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected exactly 2 comments from my-agent, found 1:\n  Ana: @my-agent triage\n  my-agent: Labelled bug"
    );
    expect(&issue)
        .not_to_have_comments_from("my-agent", 2)
        .quiet_for(QUIET)
        .await?;
    let failed = failure(
        expect(&issue)
            .not_to_have_comments_from("my-agent", 1)
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected not exactly 1 comments from my-agent, found 1:\n  Ana: @my-agent triage\n  my-agent: Labelled bug"
    );
    let discussion =
        StandIn::with(json!({ "comments": [{ "author": ana(), "text": "Summarize?" }] }));
    let failed = failure(
        expect(&discussion)
            .to_have_comment_from("my-agent")
            .timeout(FAST)
            .await,
    );
    assert_eq!(
        failed,
        "Expected a comment from my-agent. The conversation has:\n  Ana: Summarize?"
    );
    let failed = failure(
        expect(&discussion)
            .not_to_have_comment_from("Ana")
            .text("Summ")
            .quiet_for(QUIET)
            .await,
    );
    assert!(
        failed.starts_with("Expected no comment from Ana matching \"Summ\"."),
        "{failed}"
    );
    Ok(())
}

#[tokio::test]
async fn a_pull_request_its_reviews_checks_and_labels() -> Result<()> {
    let pull = StandIn::with(json!({
        "reviewComments": [{ "author": agent(), "path": "src/a.ts", "line": 3, "body": "Off by one" }],
        "reviews": [{ "author": agent(), "state": "CHANGES_REQUESTED", "body": "See inline" }],
        "checkRuns": [{ "name": "my-agent / review", "status": "completed", "conclusion": "failure" }],
        "labels": ["Bug"],
        "merged": false,
    }));
    expect(&pull)
        .to_have_review_comment()
        .path("src/a.ts")
        .line(3)
        .from("my-agent")
        .text("one")
        .await?;
    let failed = failure(
        expect(&pull)
            .to_have_review_comment()
            .path("src/a.ts")
            .line(4)
            .timeout(FAST)
            .await,
    );
    assert_eq!(
        failed,
        "Expected a comment on the diff on src/a.ts:4. The diff has:\n  my-agent on src/a.ts:3: Off by one"
    );
    expect(&pull)
        .not_to_have_review_comment()
        .path("src/b.ts")
        .quiet_for(QUIET)
        .await?;
    let failed = failure(
        expect(&pull)
            .not_to_have_review_comment()
            .from("my-agent")
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected no comment on the diff from my-agent. The diff has:\n  my-agent on src/a.ts:3: Off by one"
    );

    expect(&pull)
        .to_have_review_from("my-agent")
        .state("CHANGES_REQUESTED")
        .await?;
    let failed = failure(
        expect(&pull)
            .to_have_review_from("my-agent")
            .state("APPROVED")
            .timeout(FAST)
            .await,
    );
    assert_eq!(
        failed,
        "Expected a review from my-agent with state APPROVED. Reviews there:\n  my-agent: CHANGES_REQUESTED \"See inline\""
    );
    expect(&pull)
        .not_to_have_review_from("my-agent")
        .state("APPROVED")
        .quiet_for(QUIET)
        .await?;
    let failed = failure(
        expect(&pull)
            .not_to_have_review_from("my-agent")
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected no review from my-agent. Reviews there:\n  my-agent: CHANGES_REQUESTED \"See inline\""
    );

    // A name is the whole name; a pattern is found in it.
    expect(&pull)
        .to_have_check_run("my-agent / review")
        .conclusion("failure")
        .await?;
    expect(&pull)
        .to_have_check_run(Regex::new("review")?)
        .await?;
    let failed = failure(
        expect(&pull)
            .to_have_check_run("review")
            .status("completed")
            .conclusion("success")
            .timeout(FAST)
            .await,
    );
    assert_eq!(
        failed,
        "Expected a check run \"review\" (completed, success). Check runs there:\n  my-agent / review: completed, failure"
    );
    expect(&pull)
        .not_to_have_check_run("my-agent / review")
        .conclusion("success")
        .quiet_for(QUIET)
        .await?;
    let failed = failure(
        expect(&pull)
            .not_to_have_check_run(Regex::new("review")?)
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected no check run /review/. Check runs there:\n  my-agent / review: completed, failure"
    );

    expect(&pull).to_have_label("bug").await?;
    let failed = failure(
        expect(&pull)
            .not_to_have_label("BUG")
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(failed, "Expected no label \"BUG\". Labels there: Bug");
    // Every letter folds, not only ASCII ones, as in TypeScript and Python.
    let sized = StandIn::with(json!({ "labels": ["Größe"] }));
    expect(&sized).to_have_label("GRÖßE").await?;

    expect(&pull).not_to_be_merged().quiet_for(QUIET).await?;
    let failed = failure(expect(&pull).to_be_merged().timeout(FAST).await);
    assert_eq!(failed, "Expected the pull request to be merged");
    Ok(())
}

#[tokio::test]
async fn a_linear_issue_its_session_and_who_has_it() -> Result<()> {
    let issue = StandIn::with(json!({
        "sessionState": "complete",
        "activities": [
            { "type": "prompt", "author": ana(), "body": "Fix it" },
            { "type": "response", "author": agent(), "body": "Fixed in #12" },
        ],
        "delegate": agent(),
        "assignee": null,
        "state": { "name": "In Review", "type": "started" },
    }));
    expect(&issue).to_have_session_state("complete").await?;
    let failed = failure(
        expect(&issue)
            .to_have_session_state("active")
            .timeout(FAST)
            .await,
    );
    assert_eq!(
        failed,
        "Expected the agent session to be active, it is complete"
    );
    expect(&issue)
        .not_to_have_session_state("active")
        .quiet_for(QUIET)
        .await?;
    let failed = failure(
        expect(&issue)
            .not_to_have_session_state("complete")
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected the agent session not to be complete, it is complete"
    );

    expect(&issue)
        .to_have_activity()
        .r#type("response")
        .text("#12")
        .await?;
    // A person's turns aren't what the agent published.
    let failed = failure(
        expect(&issue)
            .to_have_activity()
            .text("Fix it")
            .timeout(FAST)
            .await,
    );
    assert_eq!(
        failed,
        "Expected a activity matching \"Fix it\". The session has:\n  my-agent (response): Fixed in #12"
    );
    expect(&issue)
        .not_to_have_activity()
        .r#type("error")
        .quiet_for(QUIET)
        .await?;
    let failed = failure(
        expect(&issue)
            .not_to_have_activity()
            .text("#12")
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected no activity matching \"#12\". The session has:\n  my-agent (response): Fixed in #12"
    );

    expect(&issue).to_be_delegated_to(agent()).await?;
    expect(&issue).to_be_assigned_to(Value::Null).await?;
    let failed = failure(expect(&issue).to_be_assigned_to(ana()).timeout(FAST).await);
    assert_eq!(
        failed,
        "Expected the issue to be assigned to Ana, it is assigned to no one"
    );
    expect(&issue)
        .not_to_be_assigned_to(ana())
        .quiet_for(QUIET)
        .await?;
    let failed = failure(
        expect(&issue)
            .not_to_be_assigned_to(Value::Null)
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected the issue not to be assigned to no one, it is assigned to no one"
    );
    let failed = failure(
        expect(&issue)
            .not_to_be_delegated_to(agent())
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected the issue not to be delegated to my-agent, it is delegated to my-agent"
    );

    expect(&issue).to_have_state("in review").await?;
    let failed = failure(expect(&issue).to_have_state("Done").timeout(FAST).await);
    assert_eq!(
        failed,
        "Expected the issue to be in \"Done\", it is in \"In Review\""
    );
    let swedish = StandIn::with(json!({ "state": { "name": "Ärende", "type": "started" } }));
    expect(&swedish).to_have_state("ärende").await?;
    expect(&issue)
        .not_to_have_state("Done")
        .quiet_for(QUIET)
        .await?;
    let failed = failure(
        expect(&issue)
            .not_to_have_state("IN REVIEW")
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected the issue not to be in \"IN REVIEW\", it is in \"In Review\""
    );
    Ok(())
}

#[tokio::test]
async fn a_notion_page_its_blocks_and_properties() -> Result<()> {
    let page = StandIn::with(json!({
        "blocks": [
            { "type": "heading_1", "heading_1": { "rich_text": [{ "plain_text": "Weekly " }, { "plain_text": "notes" }] } },
            { "type": "toggle", "toggle": { "rich_text": [] }, "children": [
                { "type": "child_page", "child_page": { "title": "Decisions" } },
            ] },
        ],
        "properties": { "Status": "Done", "Points": 3 },
    }));
    expect(&page).to_have_block("Weekly notes").await?;
    expect(&page).to_have_block("Decisions").await?;
    let failed = failure(expect(&page).to_have_block("Agenda").timeout(FAST).await);
    assert_eq!(
        failed,
        "Expected the page to have a block matching \"Agenda\". Its blocks:\n  Weekly notes\n  \n  Decisions"
    );
    expect(&page)
        .not_to_have_block("Agenda")
        .quiet_for(QUIET)
        .await?;
    let failed = failure(
        expect(&page)
            .not_to_have_block("Decisions")
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected the page not to have a block matching \"Decisions\". Its blocks:\n  Weekly notes\n  \n  Decisions"
    );

    expect(&page)
        .to_have_property_value("Status", "Done")
        .await?;
    expect(&page).to_have_property_value("Points", 3).await?;
    let failed = failure(
        expect(&page)
            .to_have_property_value("Status", "In progress")
            .timeout(FAST)
            .await,
    );
    assert_eq!(failed, "Expected Status to be In progress, it is \"Done\"");
    expect(&page)
        .not_to_have_property_value("Status", "In progress")
        .quiet_for(QUIET)
        .await?;
    let failed = failure(
        expect(&page)
            .not_to_have_property_value("Points", 3)
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(failed, "Expected Points not to be 3, it is 3");
    Ok(())
}

#[tokio::test]
async fn deliveries_accepted_rejected_and_retried() -> Result<()> {
    let accepted = StandIn::with(json!({ "attempts": [
        { "status": "acknowledged", "responseStatus": 200, "durationMs": 1200, "forgedSignature": false },
        { "status": "acknowledged", "responseStatus": 200, "durationMs": 10, "forgedSignature": false },
    ] }));
    expect(&accepted).to_be_accepted().await?;
    // Only the first attempt counts, and with `within`, how fast it was.
    let failed = failure(
        expect(&accepted)
            .to_be_accepted()
            .within("1s")
            .timeout(FAST)
            .await,
    );
    assert_eq!(
        failed,
        "Expected delivery D1 to be accepted within 1000ms, its first attempt is acknowledged (HTTP 200) after 1200ms"
    );
    expect(&accepted).to_be_retried().await?;
    expect(&accepted)
        .to_be_retried()
        .times(1)
        .quiet_for(QUIET)
        .await?;
    let failed = failure(expect(&accepted).not_to_be_retried().quiet_for(QUIET).await);
    assert_eq!(
        failed,
        "Expected delivery D1 not to be retried, it was retried 1 times"
    );
    let failed = failure(
        expect(&accepted)
            .not_to_be_accepted()
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected delivery D1 not to be accepted, its first attempt is acknowledged (HTTP 200) after 1200ms"
    );
    expect(&accepted)
        .not_to_be_rejected()
        .quiet_for(QUIET)
        .await?;

    let failed = failure(expect(&accepted).to_be_rejected().timeout(FAST).await);
    assert_eq!(
        failed,
        "Expected delivery D1 to be rejected, but no forged attempt was sent. Call delivery.resend().bad_signature(true) first"
    );
    let forged = StandIn::with(json!({ "attempts": [
        { "status": "acknowledged", "responseStatus": 200, "forgedSignature": false },
        { "status": "failed", "responseStatus": 401, "forgedSignature": true },
    ] }));
    expect(&forged).to_be_rejected().await?;
    let failed = failure(expect(&forged).not_to_be_rejected().quiet_for(QUIET).await);
    assert_eq!(
        failed,
        "Expected the forged attempt of delivery D1 not to be rejected with a 4xx, the agent answered 401"
    );
    let missing = StandIn::with(json!({ "attempts": [] }));
    let failed = failure(expect(&missing).to_be_accepted().timeout(FAST).await);
    assert_eq!(
        failed,
        "Expected delivery D1 to be accepted, its first attempt is missing"
    );
    expect(&missing)
        .not_to_be_accepted()
        .quiet_for(QUIET)
        .await?;
    Ok(())
}

#[tokio::test]
async fn api_calls_by_name_pattern_count_and_error() -> Result<()> {
    let slack = StandIn::with(json!({ "calls": [
        { "operation": "chat.postMessage" },
        { "operation": "chat.postMessage", "error": "not_in_channel" },
        { "operation": "reactions.add" },
    ] }));
    expect(&slack)
        .to_have_received_call("chat.postMessage")
        .await?;
    expect(&slack)
        .to_have_received_call(Regex::new("^chat\\.")?)
        .times(2)
        .quiet_for(QUIET)
        .await?;
    // A name is the whole name.
    expect(&slack)
        .not_to_have_received_call("chat.post")
        .quiet_for(QUIET)
        .await?;
    expect(&slack)
        .to_have_received_call("chat.postMessage")
        .error("not_in_channel")
        .await?;
    assert_eq!(*slack.filtered_by.lock().unwrap(), json!("not_in_channel"));
    let failed = failure(
        expect(&slack)
            .to_have_received_call("chat.postMessage")
            .times(1)
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected the agent to call \"chat.postMessage\" 1 times, found 2. Its calls:\n  chat.postMessage\n  chat.postMessage → not_in_channel\n  reactions.add"
    );
    // With `error`, only the calls refused so count.
    expect(&slack)
        .not_to_have_received_call("reactions.add")
        .error("ratelimited")
        .quiet_for(QUIET)
        .await
}

/// A few bytes that aren't text, as a fixture image has.
const PNG: [u8; 6] = [0x89, b'P', b'N', b'G', 0, 255];

fn png_sha256() -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(PNG)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The openai fixture: calls, the newest last, with the images, files and audio they carried.
fn model() -> StandIn {
    StandIn::with(json!({ "modelCalls": [
        { "request": { "messages": [{ "role": "user", "parts": [{ "type": "image", "from": "url", "url": "https://example.com/a.png" }] }] } },
        // A media endpoint's call: its file is its message's first part.
        { "request": { "messages": [{ "role": "user", "parts": [{ "type": "audio", "from": "data", "mediaType": "audio/wav", "bytes": 44, "sha256": "ab".repeat(32) }] }] } },
        { "request": { "messages": [
            { "role": "system", "text": "be brief" },
            { "role": "user", "parts": [{ "type": "image", "from": "data", "mediaType": "image/png", "bytes": 6, "sha256": png_sha256() }] },
        ] } },
    ] }))
}

#[tokio::test]
async fn a_file_sent_holds_for_its_path_and_for_its_bytes() -> Result<()> {
    let root = tempfile::tempdir().unwrap();
    let chart = root.path().join("chart.png");
    std::fs::write(&chart, PNG).unwrap();
    let model = model();
    expect(&model)
        .to_have_sent_file(chart.display().to_string())
        .timeout(FAST)
        .await?;
    expect(&model)
        .to_have_sent_file(PNG.to_vec())
        .timeout(FAST)
        .await?;
    let message = failure(
        expect(&StandIn::with(
            json!({ "modelCalls": [{ "request": { "messages": [{ "role": "user" }] } }] }),
        ))
        .to_have_sent_file(chart.display().to_string())
        .timeout(FAST)
        .await,
    );
    assert_eq!(
        message,
        format!(
            "Expected the agent to send the model chart.png (6 bytes, sha256 {}). It sent no image, file or audio.",
            &png_sha256()[..12]
        )
    );
    // A path that isn't there is an error, not a failed check.
    assert!(matches!(
        expect(&model)
            .to_have_sent_file(root.path().join("missing.png").display().to_string())
            .timeout(FAST)
            .await,
        Err(Error::Files { .. })
    ));
    Ok(())
}

// --- The model ------------------------------------------------------------------------------------

#[tokio::test]
async fn to_have_answered_counts_the_turns_that_reached_the_agent_not_those_the_fake_refused()
-> Result<()> {
    let refused = StandIn::with(json!({ "script": {
        "id": "ms_1",
        "used": 1,
        "problems": ["ms_1 called `search_incidents`, but the request offered no tools"],
        "calls": [{ "response": { "error": "channelstack_no_script" } }],
    }}));
    assert_eq!(
        failure(expect(&refused).to_have_answered().timeout(FAST).await),
        "Expected script ms_1 to answer a call, it answered 0. Its problems:\n  ms_1 called `search_incidents`, but the request offered no tools"
    );
    // A held call (a responder still answering) isn't answered yet; a scripted error is an answer.
    let held = StandIn::with(
        json!({ "script": { "id": "ms_1", "used": 1, "problems": [], "calls": [{ "response": {} }] } }),
    );
    assert!(failure(expect(&held).to_have_answered().timeout(FAST).await).contains("answered 0"));
    let answered = StandIn::with(
        json!({ "script": { "id": "ms_1", "used": 3, "problems": [], "calls": [
            { "response": { "text": "All good." } },
            { "response": { "error": "rate_limit_exceeded" } },
            { "response": { "error": "channelstack_no_script" } },
        ]}}),
    );
    expect(&answered)
        .to_have_answered()
        .times(2)
        .quiet_for(QUIET)
        .await
}

#[tokio::test]
async fn to_have_answered_leaves_out_a_call_the_agent_hung_up_on_before_its_first_token()
-> Result<()> {
    // The fake had the answer, but the agent was gone before a byte of it was sent.
    let abandoned = StandIn::with(
        json!({ "script": { "id": "ms_1", "used": 1, "problems": [], "calls": [
            { "response": { "status": 0, "text": "Too late.", "end": "aborted" } },
        ]}}),
    );
    assert_eq!(
        failure(expect(&abandoned).to_have_answered().timeout(FAST).await),
        "Expected script ms_1 to answer a call, it answered 0"
    );
    // A scripted timeout reached the agent, and so did a stream it hung up on midway.
    let counted = StandIn::with(
        json!({ "script": { "id": "ms_1", "used": 3, "problems": [], "calls": [
            { "response": { "status": 0, "text": "Too late.", "end": "aborted" } },
            { "response": { "status": 0, "error": "timeout", "end": "aborted" } },
            { "response": { "status": 200, "text": "Half of it", "end": "aborted" } },
        ]}}),
    );
    expect(&counted)
        .to_have_answered()
        .times(2)
        .quiet_for(QUIET)
        .await
}

#[tokio::test]
async fn to_have_sent_compares_text_as_attribution_does_a_slack_link_is_its_url() -> Result<()> {
    let call = StandIn::with(json!({ "modelCalls": [
        { "request": { "text": "Ana: Deploy   https://example.com/runs/7 NOW", "tools": [] } },
    ]}));
    expect(&call)
        .to_have_sent("<@U08B5K2M9QX> deploy <https://example.com/runs/7|the run> now")
        .timeout(FAST)
        .await?;
    Ok(())
}

#[tokio::test]
async fn a_file_not_sent_fails_with_what_was_sent_newest_first() {
    let message = failure(
        expect(&model())
            .to_have_sent_file(vec![1u8, 2, 3])
            .timeout(FAST)
            .await,
    );
    assert_eq!(
        message,
        [
            "Expected the agent to send the model these bytes (3 bytes, sha256 039058c6f2c0). What it sent, newest first:".to_owned(),
            format!("  image, image/png, 6 bytes, sha256 {}", &png_sha256()[..12]),
            "  audio, audio/wav, 44 bytes, sha256 abababababab".to_owned(),
            "  image, https://example.com/a.png".to_owned(),
        ]
        .join("\n")
    );
}

#[tokio::test]
async fn a_file_not_to_be_sent_once_quiet() -> Result<()> {
    let model = model();
    expect(&model)
        .not_to_have_sent_file(vec![1u8])
        .timeout(FAST)
        .quiet_for(QUIET)
        .await?;
    let message = failure(
        expect(&model)
            .not_to_have_sent_file(PNG.to_vec())
            .timeout(FAST)
            .quiet_for(QUIET)
            .await,
    );
    assert!(
        message.starts_with("Expected the agent not to send the model these bytes (6 bytes"),
        "{message}"
    );
    Ok(())
}

#[tokio::test]
async fn a_failing_check_names_the_model_calls_no_session_claimed_recent_ones_only() {
    let thread = StandIn::with(json!({ "unattributed": [{
        "id": "chatcmpl-1",
        "lastUserText": "summarise the backlog",
        "sinceMs": 2400,
        "message": "this call couldn't be attributed to any test: nothing in it matches.",
    }]}));
    assert_eq!(
        failure(
            expect(&thread)
                .to_have_reply_from("my-agent")
                .timeout(FAST)
                .await
        ),
        [
            "Expected a reply from my-agent. The thread has:\n  (nothing)",
            "1 model call in the last 10s couldn't be attributed to a test:",
            "  chatcmpl-1 (\"summarise the backlog\", 2s ago): this call couldn't be attributed to any test: nothing in it matches.",
        ]
        .join("\n")
    );
    assert_eq!(*thread.asked.lock().unwrap(), vec![10_000]);
}

fn by_order(call: &str) -> Value {
    json!({ "id": call, "request": { "context": {
        "attributedBy": "order", "matched": "@my-agent hello", "tiedWith": ["ses_2"],
    }}})
}

#[tokio::test]
async fn a_failing_check_names_the_sessions_a_call_attributed_by_order_tied_with() {
    let thread = StandIn::with(json!({ "sessionCalls": [
        by_order("chatcmpl-1"),
        { "id": "chatcmpl-2", "request": { "context": { "attributedBy": "text" } } },
    ]}));
    assert_eq!(
        failure(
            expect(&thread)
                .to_have_reply_from("my-agent")
                .timeout(FAST)
                .await
        ),
        [
            "Expected a reply from my-agent. The thread has:\n  (nothing)",
            "Model call chatcmpl-1 was attributed by order, between 2 sessions that all sent \"@my-agent hello\" (this one and ses_2): each went to the oldest unanswered message. Give each test's prompt something of its own, or have the agent send `user`.",
        ]
        .join("\n")
    );
    let notes = super::model_notes(&[], &[by_order("chatcmpl-1"), by_order("chatcmpl-3")]);
    assert_eq!(notes.len(), 1);
    assert!(
        notes[0].starts_with(
            "Model calls chatcmpl-1, chatcmpl-3 were attributed by order, between 2 sessions"
        ),
        "{notes:?}"
    );
}

#[tokio::test]
async fn to_go_quiet_counts_app_messages_since_a_person_wrote() -> Result<()> {
    // Exit check 12.6: two apps answering each other, with what came before the check counted.
    let coder = || json!({ "id": "B02", "name": "coder", "kind": "app" });
    let turns = |count: usize| {
        let mut said = vec![says(ana(), "fix the login page")];
        said.extend((0..count).map(|at| says(if at % 2 == 0 { agent() } else { coder() }, "turn")));
        StandIn::saying(said)
    };
    expect(&turns(2)).to_go_quiet(4).quiet_for(QUIET).await?;
    let failed = failure(
        expect(&turns(5))
            .to_go_quiet(4)
            .within("1s")
            .quiet_for(QUIET)
            .await,
    );
    assert_eq!(
        failed,
        "Expected the conversation to go quiet within 1s with at most 4 app messages since a person last wrote. It went quiet with 5 app messages and no person between them: my-agent → coder → my-agent → coder → my-agent"
    );
    // A person writing starts the count over.
    let mut said = vec![
        says(ana(), "hi"),
        says(agent(), "a"),
        says(coder(), "b"),
        says(ana(), "thanks"),
    ];
    said.push(says(agent(), "welcome"));
    expect(&StandIn::saying(said))
        .to_go_quiet(1)
        .quiet_for(QUIET)
        .await
}

#[tokio::test]
async fn to_go_quiet_reports_the_loops_the_fake_stopped() {
    // As matchers-core does: the loop the guard stopped is named after the turns.
    let stopped =
        "a bot loop in slack 1.2 (50 app messages with no person between them: my-agent → coder …)";
    let coder = || json!({ "id": "B02", "name": "coder", "kind": "app" });
    let mut said = vec![says(ana(), "fix the login page")];
    said.extend((0..3).map(|at| says(if at % 2 == 0 { agent() } else { coder() }, "turn")));
    let subject = StandIn {
        loops: vec![stopped.to_owned()],
        ..StandIn::saying(said)
    };
    let failed = failure(
        expect(&subject)
            .to_go_quiet(2)
            .within("1s")
            .quiet_for(QUIET)
            .await,
    );
    assert!(
        failed.ends_with(&format!("my-agent → coder → my-agent\nStopped: {stopped}")),
        "{failed}"
    );
}
