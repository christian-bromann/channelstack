//! `expect(&subject).to_…()`: the matchers of `channelstack/vitest`, for Rust tests.
//!
//! ```no_run
//! # async fn example(thread: channelstack::SlackThread, app: channelstack::SlackApp) -> channelstack::Result<()> {
//! use channelstack::{Regex, expect};
//!
//! expect(&thread).to_have_reply_from("my-agent").text(Regex::new("(?i)incident")?).await?;
//! expect(&thread).to_have_replies_from(&app, 1).await?;
//! expect(&thread.conversation()).not_to_have_channel_message_from("my-agent").await?;
//! # Ok(())
//! # }
//! ```
//!
//! Each check reads plain SDK methods, the way the TypeScript matchers do
//! (`integrations/matchers-core`), with their semantics and failure messages:
//!
//! - A positive check polls until it holds, and fails after the timeout with what was there.
//! - A negative check (`not_to_…`) and one with an exact count wait until the agent has been quiet
//!   for the whole quiet window, watched from start to end, and check once.
//! - A failure is `Error::Expectation` with the whole message, plus `Still open: …` when the
//!   session reports work the agent left open. `?` in a test that returns `Result` fails the test
//!   with it.
//!
//! The defaults are the waits' (`DEFAULT_TIMEOUT`, `DEFAULT_QUIET_FOR`). An author is a handle
//! (`&app`) or a name; text is a string to contain or a pattern (`Regex`, or `{ "source": … }`).

use std::future::{Future, IntoFuture};
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::runtime::client::{BoxFuture, IntoArg};
use crate::runtime::duration::parse_duration;
use crate::runtime::error::{Error, Result};
use crate::runtime::files::read_media;
use crate::runtime::wait::{
    DEFAULT_QUIET_FOR, DEFAULT_TIMEOUT, check_text, from_matches, model_problems, text_matches,
    until_quiet, wait_for,
};

pub mod subjects;
use subjects::*;

#[cfg(test)]
mod tests;

/// The checks on a subject: `expect(&message.thread()).to_have_reply_from("my-agent").await?`.
pub fn expect<S: Subject + ?Sized>(subject: &S) -> Expectation<'_, S> {
    Expectation { subject }
}

/// The checks on one subject. Each is a builder: set its options, then `.await` it.
pub struct Expectation<'a, S: ?Sized> {
    subject: &'a S,
}

impl<S: ?Sized> Clone for Expectation<'_, S> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<S: ?Sized> Copy for Expectation<'_, S> {}

/// The options a check was given, by their names in the API (`timeout`, `quietFor`, `text`).
struct Options(Map<String, Value>);

impl Options {
    fn get(&self, name: &str) -> &Value {
        self.0.get(name).unwrap_or(&Value::Null)
    }
    fn or(&self, name: &str, default: &str) -> Value {
        self.0
            .get(name)
            .cloned()
            .unwrap_or_else(|| Value::from(default))
    }
    /// Text to look for, refused up front when it is a pattern that can never match.
    fn text(&self, name: &str) -> Result<Value> {
        let text = self.get(name).clone();
        check_text(&text)?;
        Ok(text)
    }
    fn number(&self, name: &str) -> Option<i64> {
        self.get(name).as_i64()
    }
}

type Run<'a> = Box<dyn FnOnce(Options) -> BoxFuture<'a, Result<()>> + Send + 'a>;

/// A check as it is being built: its options so far, and what runs it.
struct Check<'a> {
    options: Map<String, Value>,
    run: Run<'a>,
}

impl<'a> Check<'a> {
    fn new<F, Fut>(run: F) -> Self
    where
        F: FnOnce(Options) -> Fut + Send + 'a,
        Fut: Future<Output = Result<()>> + Send + 'a,
    {
        Self {
            options: Map::new(),
            run: Box::new(move |options| Box::pin(run(options))),
        }
    }
    fn option(mut self, name: &str, value: impl IntoArg) -> Self {
        self.options.insert(name.to_owned(), value.into_arg());
        self
    }
    fn run(self) -> BoxFuture<'a, Result<()>> {
        (self.run)(Options(self.options))
    }
}

/// A check's builder: `NOT` is true for `not_to_…`. Every one takes `timeout`; a negative one, or
/// one that can count, also `quiet_for`.
macro_rules! check {
    (@struct $(#[$doc:meta])* $name:ident { $($setter:ident($key:literal): $ty:ty),* }) => {
        $(#[$doc])*
        #[must_use = "a check does nothing until it is awaited"]
        pub struct $name<'a, const NOT: bool>(Check<'a>);

        impl<const NOT: bool> $name<'_, NOT> {
            $(
                #[doc = concat!("`", $key, "`.")]
                pub fn $setter(self, value: $ty) -> Self {
                    Self(self.0.option($key, value))
                }
            )*
        }

        impl<'a, const NOT: bool> IntoFuture for $name<'a, NOT> {
            type Output = Result<()>;
            type IntoFuture = BoxFuture<'a, Result<()>>;
            fn into_future(self) -> Self::IntoFuture {
                self.0.run()
            }
        }
    };
    ($(#[$doc:meta])* $name:ident counts { $($setter:ident($key:literal): $ty:ty),* $(,)? }) => {
        check!(@struct $(#[$doc])* $name {
            $($setter($key): $ty,)* timeout("timeout"): impl IntoArg, quiet_for("quietFor"): impl IntoArg
        });
    };
    ($(#[$doc:meta])* $name:ident { $($setter:ident($key:literal): $ty:ty),* $(,)? }) => {
        check!(@struct $(#[$doc])* $name { $($setter($key): $ty,)* timeout("timeout"): impl IntoArg });

        impl $name<'_, true> {
            /// `quietFor`: how long the agent must have been quiet before the check looks.
            pub fn quiet_for(self, value: impl IntoArg) -> Self {
                Self(self.0.option("quietFor", value))
            }
        }
    };
}

check!(
    /// [`Expectation::to_have_reply_from`].
    ReplyFrom { text("text"): impl IntoArg }
);
check!(
    /// [`Expectation::to_have_replies_from`].
    RepliesFrom counts { text("text"): impl IntoArg }
);
check!(
    /// [`Expectation::to_have_channel_message_from`].
    ChannelMessageFrom {}
);
check!(
    /// [`Expectation::to_contain_text`].
    ContainText counts {
        count("count"): usize,
        from("from"): impl IntoArg,
        r#as("as"): impl IntoArg,
    }
);
check!(
    /// [`Expectation::to_have_streaming_reply_from`].
    StreamingReplyFrom {}
);
check!(
    /// [`Expectation::to_have_status`].
    HaveStatus {}
);
check!(
    /// [`Expectation::to_have_status_text`].
    StatusText {}
);
check!(
    /// [`Expectation::to_have_button`].
    Button {}
);
check!(
    /// [`Expectation::to_have_reaction`].
    Reaction { by("by"): impl IntoArg }
);
check!(
    /// [`Expectation::to_have_opened_modal`].
    OpenedModal {}
);
check!(
    /// [`Expectation::to_have_comment_from`].
    CommentFrom { text("text"): impl IntoArg }
);
check!(
    /// [`Expectation::to_have_comments_from`].
    CommentsFrom counts {}
);
check!(
    /// [`Expectation::to_have_review_comment`]: matched by every field that is given.
    ReviewComment {
        path("path"): &str,
        line("line"): u64,
        from("from"): impl IntoArg,
        text("text"): impl IntoArg,
    }
);
check!(
    /// [`Expectation::to_have_review_from`].
    ReviewFrom { state("state"): &str }
);
check!(
    /// [`Expectation::to_have_check_run`].
    CheckRun { status("status"): &str, conclusion("conclusion"): &str }
);
check!(
    /// [`Expectation::to_have_label`].
    Label {}
);
check!(
    /// [`Expectation::to_be_merged`].
    Merged {}
);
check!(
    /// [`Expectation::to_have_session_state`].
    SessionState {}
);
check!(
    /// [`Expectation::to_have_activity`]: matched by every field that is given.
    Activity {
        r#type("type"): &str,
        from("from"): impl IntoArg,
        text("text"): impl IntoArg,
    }
);
check!(
    /// [`Expectation::to_be_delegated_to`].
    DelegatedTo {}
);
check!(
    /// [`Expectation::to_be_assigned_to`].
    AssignedTo {}
);
check!(
    /// [`Expectation::to_have_block`].
    Block {}
);
check!(
    /// [`Expectation::to_have_property_value`].
    PropertyValue {}
);
check!(
    /// [`Expectation::to_have_state`].
    WorkflowState {}
);
check!(
    /// [`Expectation::to_be_accepted`].
    Accepted { within("within"): impl IntoArg }
);
check!(
    /// [`Expectation::to_be_rejected`].
    Rejected {}
);
check!(
    /// [`Expectation::to_be_retried`].
    Retried counts { times("times"): usize }
);
check!(
    /// [`Expectation::to_have_received_call`].
    ReceivedCall counts { times("times"): usize, error("error"): &str }
);

/// [`Expectation::to_be_ephemeral_for`]: it reads the message as it is, so it takes no options.
#[must_use = "a check does nothing until it is awaited"]
pub struct EphemeralFor<'a, const NOT: bool>(Check<'a>);

impl<'a, const NOT: bool> IntoFuture for EphemeralFor<'a, NOT> {
    type Output = Result<()>;
    type IntoFuture = BoxFuture<'a, Result<()>>;
    fn into_future(self) -> Self::IntoFuture {
        self.0.run()
    }
}

/// Run a check the way its kind needs: poll until it holds, or wait for quiet and check once.
/// `describe` says what was expected and what was there instead.
async fn settle<S, T, R, RF, H, D>(
    subject: &S,
    negate: bool,
    once_quiet: bool,
    options: &Options,
    read: R,
    holds: H,
    describe: D,
) -> Result<()>
where
    S: Subject + ?Sized,
    T: Send,
    R: Fn() -> RF,
    RF: Future<Output = Result<T>>,
    H: Fn(&T) -> bool,
    D: Fn(&T) -> String,
{
    let timeout = options.or("timeout", DEFAULT_TIMEOUT);
    let value = if once_quiet || negate {
        // The check watches for the whole quiet window: what arrives while it looks counts.
        let quiet_for = options.or("quietFor", DEFAULT_QUIET_FOR);
        until_quiet(|| subject.quiet(), &timeout, &quiet_for, true).await?;
        read().await?
    } else {
        let last = Mutex::new(None);
        let polls = std::sync::atomic::AtomicUsize::new(0);
        let held = wait_for("the condition", &timeout, || {
            let attempt = read();
            let (last, holds, polls) = (&last, &holds, &polls);
            async move {
                let value = attempt.await?;
                if holds(&value) {
                    return Ok(Some(value));
                }
                *last.lock().expect("the last value read") = Some(value);
                // A model call no script answered won't be answered by waiting: fail now, with why.
                if polls.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % 5 == 4 {
                    fail_on_problems(subject).await?;
                }
                Ok(None)
            }
        })
        .await;
        match held {
            Ok(value) => value,
            Err(Error::Timeout { .. }) => {
                fail_on_problems(subject).await?;
                last.into_inner()
                    .expect("the last value read")
                    .expect("a wait reads at least once")
            }
            Err(error) => return Err(error),
        }
    };
    if holds(&value) != negate {
        return Ok(());
    }
    // A failed check also says what the agent left open (a stream it never stopped): often that is the bug.
    let open = still_open(subject).await?;
    let leftover = if open.is_empty() {
        String::new()
    } else {
        format!("\nStill open: {}", open.join("; "))
    };
    Err(Error::Expectation(format!(
        "{}{leftover}",
        describe(&value)
    )))
}

/// Fail with the session's model problems, if it has any. Nothing where the server can't tell.
async fn fail_on_problems<S: Subject + ?Sized>(subject: &S) -> Result<()> {
    match subject.quiet().await {
        Ok(state) if !state.problems.is_empty() => Err(model_problems(&state.problems)),
        Ok(_) | Err(Error::Api { .. }) => Ok(()),
        Err(error) => Err(error),
    }
}

/// What the agent has left open in the subject's session, in words. Nothing where the server
/// can't tell (live, without proxy mode): it only adds to a failure's message.
async fn still_open<S: Subject + ?Sized>(subject: &S) -> Result<Vec<String>> {
    match subject.quiet().await {
        Ok(state) => Ok(state.open),
        Err(Error::Api { .. }) => Ok(vec![]),
        Err(error) => Err(error),
    }
}

/// A channel's call has an operation; a model call has its endpoint (`chat.completions`).
fn operation_of(call: &Value) -> &str {
    match text_of(call, "operation") {
        "" => text_of(call, "endpoint"),
        operation => operation,
    }
}

/// The items of a list the server answered.
fn items(list: Value) -> Vec<Value> {
    match list {
        Value::Array(items) => items,
        _ => vec![],
    }
}

/// A text field, or `""`.
fn text_of<'v>(value: &'v Value, field: &str) -> &'v str {
    value.get(field).and_then(Value::as_str).unwrap_or("")
}

fn author_name(item: &Value) -> &str {
    text_of(&item["author"], "name")
}

/// Is this the name, in any case? Every letter folds, as `toLowerCase()` and Python's `lower()` do.
fn same_name(found: &str, name: &str) -> bool {
    found.to_lowercase() == name.to_lowercase()
}

/// An author as a check was given it: a name, or a handle's name.
fn name_of(author: &Value) -> &str {
    author.as_str().unwrap_or_else(|| text_of(author, "name"))
}

/// Expected text as a failure shows it: a string quoted, a pattern as `/source/flags`.
fn show(expected: &Value) -> String {
    match expected {
        Value::Object(pattern) if pattern.contains_key("source") => format!(
            "/{}/{}",
            text_of(expected, "source"),
            text_of(expected, "flags")
        ),
        other => other.to_string(),
    }
}

/// ` matching …` for text that was given.
fn matching(text: &Value) -> String {
    if text.is_null() {
        String::new()
    } else {
        format!(" matching {}", show(text))
    }
}

/// An operation or a check run's name: a string is the whole name, a pattern is found in it.
fn name_matches(name: &str, expected: &Value) -> bool {
    match expected {
        Value::String(wanted) => name == wanted,
        pattern => text_matches(name, pattern),
    }
}

fn listing(lines: impl IntoIterator<Item = String>) -> String {
    let lines: Vec<String> = lines.into_iter().map(|line| format!("  {line}")).collect();
    if lines.is_empty() {
        "  (nothing)".into()
    } else {
        lines.join("\n")
    }
}

fn says(messages: &[Value]) -> String {
    listing(
        messages
            .iter()
            .map(|message| format!("{}: {}", author_name(message), text_of(message, "text"))),
    )
}

fn said_by(message: &Value, author: &Value, text: &Value) -> bool {
    from_matches(&message["author"], author) && text_matches(text_of(message, "text"), text)
}

/// A comment's text: GitHub and Linear call it `body`, Notion `text`.
fn comment_text(comment: &Value) -> &str {
    comment
        .get("body")
        .or_else(|| comment.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn comment_by(comment: &Value, author: &Value, text: &Value) -> bool {
    from_matches(&comment["author"], author) && text_matches(comment_text(comment), text)
}

fn written(comments: &[Value]) -> String {
    listing(
        comments
            .iter()
            .map(|comment| format!("{}: {}", author_name(comment), comment_text(comment))),
    )
}

/// The text of each block of a Notion page, nested ones included: its rich text, or a child page's title.
fn block_texts(blocks: &[Value]) -> Vec<String> {
    blocks
        .iter()
        .flat_map(|block| {
            let data = &block[text_of(block, "type")];
            let text = match data.get("rich_text").and_then(Value::as_array) {
                Some(rich) => rich
                    .iter()
                    .map(|item| text_of(item, "plain_text"))
                    .collect(),
                None => text_of(data, "title").to_owned(),
            };
            let children = block
                .get("children")
                .and_then(Value::as_array)
                .map(|children| block_texts(children))
                .unwrap_or_default();
            std::iter::once(text).chain(children)
        })
        .collect()
}

/// `not ` for a negative check, as the expectation says it.
fn not(negate: bool) -> &'static str {
    if negate { "not " } else { "" }
}

/// `no` for a negative check, `a` otherwise.
fn no_or(negate: bool, positive: &'static str) -> &'static str {
    if negate { "no" } else { positive }
}

/// What a person who expected `a …` says under `not`: `no …`.
fn negated(negate: bool, wanted: String) -> String {
    match wanted.strip_prefix("a ") {
        Some(rest) if negate => format!("no {rest}"),
        _ => wanted,
    }
}

impl<'a, S: Said + ?Sized> Expectation<'a, S> {
    /// The thread (or DM) has a reply from this author, matching `text` if it is given.
    pub fn to_have_reply_from(self, author: impl IntoArg) -> ReplyFrom<'a, false> {
        self.reply_from(author.into_arg())
    }
    /// Once the agent is quiet, the thread has no reply from this author (matching `text`, if given).
    pub fn not_to_have_reply_from(self, author: impl IntoArg) -> ReplyFrom<'a, true> {
        self.reply_from(author.into_arg())
    }
    fn reply_from<const NOT: bool>(self, author: Value) -> ReplyFrom<'a, NOT> {
        let subject = self.subject;
        ReplyFrom(Check::new(move |options| async move {
            let text = options.text("text")?;
            let expected = negated(
                NOT,
                format!("a reply from {}{}", name_of(&author), matching(&text)),
            );
            settle(
                subject,
                NOT,
                false,
                &options,
                || async { Ok(items(subject.read_said().await?)) },
                |messages| {
                    messages
                        .iter()
                        .any(|message| said_by(message, &author, &text))
                },
                |messages| format!("Expected {expected}. The thread has:\n{}", says(messages)),
            )
            .await
        }))
    }

    /// Exactly `count` replies from this author (matching `text`, if given), checked once the agent is quiet.
    pub fn to_have_replies_from(
        self,
        author: impl IntoArg,
        count: usize,
    ) -> RepliesFrom<'a, false> {
        self.replies_from(author.into_arg(), count)
    }
    /// Any number of replies from this author but `count`, checked once the agent is quiet.
    pub fn not_to_have_replies_from(
        self,
        author: impl IntoArg,
        count: usize,
    ) -> RepliesFrom<'a, true> {
        self.replies_from(author.into_arg(), count)
    }
    fn replies_from<const NOT: bool>(self, author: Value, count: usize) -> RepliesFrom<'a, NOT> {
        let subject = self.subject;
        RepliesFrom(Check::new(move |options| async move {
            let text = options.text("text")?;
            let noun = if count == 1 { "reply" } else { "replies" };
            settle(
                subject,
                NOT,
                true,
                &options,
                || async {
                    let said = items(subject.read_said().await?);
                    Ok(said
                        .into_iter()
                        .filter(|message| said_by(message, &author, &text))
                        .collect::<Vec<_>>())
                },
                |replies| replies.len() == count,
                |replies| {
                    format!(
                        "Expected {}exactly {count} {noun} from {}, found {}:\n{}",
                        not(NOT),
                        name_of(&author),
                        replies.len(),
                        says(replies)
                    )
                },
            )
            .await
        }))
    }

    /// A reply from this author is being streamed right now. `Value::Null` for any author.
    pub fn to_have_streaming_reply_from(
        self,
        author: impl IntoArg,
    ) -> StreamingReplyFrom<'a, false> {
        self.streaming_reply_from(author.into_arg())
    }
    /// Once the agent is quiet, no reply from this author (`Value::Null`: anyone's) is being streamed.
    pub fn not_to_have_streaming_reply_from(
        self,
        author: impl IntoArg,
    ) -> StreamingReplyFrom<'a, true> {
        self.streaming_reply_from(author.into_arg())
    }
    fn streaming_reply_from<const NOT: bool>(self, author: Value) -> StreamingReplyFrom<'a, NOT> {
        let subject = self.subject;
        StreamingReplyFrom(Check::new(move |options| async move {
            let by = if author.is_null() {
                String::new()
            } else {
                format!(" by {}", name_of(&author))
            };
            let stream = |message: &Value| message["stream"]["state"].as_str().map(str::to_owned);
            settle(
                subject,
                NOT,
                false,
                &options,
                || async { Ok(items(subject.read_said().await?)) },
                |messages| {
                    messages.iter().any(|message| {
                        stream(message).as_deref() == Some("open")
                            && from_matches(&message["author"], &author)
                    })
                },
                |messages| {
                    format!(
                        "Expected {} reply being streamed{by}. The thread has:\n{}",
                        no_or(NOT, "a"),
                        listing(messages.iter().map(|message| format!(
                            "{}: {} [{}]",
                            author_name(message),
                            text_of(message, "text"),
                            stream(message).unwrap_or_else(|| "not a stream".into())
                        )))
                    )
                },
            )
            .await
        }))
    }
}

impl<'a, S: ChannelMessages + ?Sized> Expectation<'a, S> {
    /// A message from this author directly in the channel, outside any thread.
    pub fn to_have_channel_message_from(
        self,
        author: impl IntoArg,
    ) -> ChannelMessageFrom<'a, false> {
        self.channel_message_from(author.into_arg())
    }
    /// Once the agent is quiet, no message from this author directly in the channel.
    pub fn not_to_have_channel_message_from(
        self,
        author: impl IntoArg,
    ) -> ChannelMessageFrom<'a, true> {
        self.channel_message_from(author.into_arg())
    }
    fn channel_message_from<const NOT: bool>(self, author: Value) -> ChannelMessageFrom<'a, NOT> {
        let subject = self.subject;
        ChannelMessageFrom(Check::new(move |options| async move {
            let name = name_of(&author);
            settle(
                subject,
                NOT,
                false,
                &options,
                || async {
                    let messages = items(subject.read_messages().await?);
                    Ok(messages
                        .into_iter()
                        .filter(|message| said_by(message, &author, &Value::Null))
                        .collect::<Vec<_>>())
                },
                |messages| !messages.is_empty(),
                |messages| {
                    if NOT {
                        format!(
                            "Expected no message from {name} in the channel itself, found:\n{}",
                            says(messages)
                        )
                    } else {
                        format!("Expected a message from {name} in the channel itself, found none")
                    }
                },
            )
            .await
        }))
    }
}

impl<'a, S: Readable + ?Sized> Expectation<'a, S> {
    /// Some entry a person would see contains this text. `count` makes it exact, checked once the
    /// agent is quiet; `from` keeps one author's entries; `as` (Slack) reads it as that person sees it.
    pub fn to_contain_text(self, text: impl IntoArg) -> ContainText<'a, false> {
        self.contain_text(text.into_arg())
    }
    /// Once the agent is quiet, no entry a person would see contains this text.
    pub fn not_to_contain_text(self, text: impl IntoArg) -> ContainText<'a, true> {
        self.contain_text(text.into_arg())
    }
    fn contain_text<const NOT: bool>(self, text: Value) -> ContainText<'a, NOT> {
        let subject = self.subject;
        ContainText(Check::new(move |options| async move {
            check_text(&text)?;
            let count = options.number("count");
            let from = options.get("from").clone();
            let viewer = options.get("as").clone();
            let matching_entries = |entries: &[Value]| {
                entries
                    .iter()
                    .filter(|entry| text_matches(text_of(entry, "text"), &text))
                    .count()
            };
            let expected = match count {
                _ if NOT => "no text".to_owned(),
                None => "text".to_owned(),
                Some(count) => format!("exactly {count} entries with text"),
            };
            settle(
                subject,
                NOT,
                count.is_some(),
                &options,
                || async {
                    let transcript = subject.read_transcript(viewer.clone()).await?;
                    Ok(items(transcript["entries"].clone())
                        .into_iter()
                        .filter(|entry| from_matches(&entry["author"], &from))
                        .collect::<Vec<_>>())
                },
                |entries| {
                    let found = matching_entries(entries);
                    count.map_or(found > 0, |count| found as i64 == count)
                },
                |entries| {
                    format!(
                        "Expected {expected} matching {}, found {}. A person sees:\n{}",
                        show(&text),
                        matching_entries(entries),
                        says(entries)
                    )
                },
            )
            .await
        }))
    }
}

impl<'a, S: Status + ?Sized> Expectation<'a, S> {
    /// The agent's state in this thread: `working`, `streaming`, `stopped` or `idle`.
    pub fn to_have_status(self, state: &str) -> HaveStatus<'a, false> {
        self.status(state.to_owned())
    }
    /// Once the agent is quiet, its state in this thread is another one.
    pub fn not_to_have_status(self, state: &str) -> HaveStatus<'a, true> {
        self.status(state.to_owned())
    }
    fn status<const NOT: bool>(self, expected: String) -> HaveStatus<'a, NOT> {
        let subject = self.subject;
        HaveStatus(Check::new(move |options| async move {
            settle(
                subject,
                NOT,
                false,
                &options,
                || subject.read_status(),
                |status| text_of(status, "state") == expected,
                |status| {
                    let line = match text_of(status, "text") {
                        "" => String::new(),
                        text => format!(" (\"{text}\")"),
                    };
                    format!(
                        "Expected the thread {}to be {expected}, it is {}{line}",
                        not(NOT),
                        text_of(status, "state")
                    )
                },
            )
            .await
        }))
    }

    /// The status line the agent set matches this text.
    pub fn to_have_status_text(self, text: impl IntoArg) -> StatusText<'a, false> {
        self.status_text(text.into_arg())
    }
    /// Once the agent is quiet, its status line doesn't match this text.
    pub fn not_to_have_status_text(self, text: impl IntoArg) -> StatusText<'a, true> {
        self.status_text(text.into_arg())
    }
    fn status_text<const NOT: bool>(self, text: Value) -> StatusText<'a, NOT> {
        let subject = self.subject;
        StatusText(Check::new(move |options| async move {
            check_text(&text)?;
            settle(
                subject,
                NOT,
                false,
                &options,
                || subject.read_status(),
                |status| {
                    status["text"]
                        .as_str()
                        .is_some_and(|line| text_matches(line, &text))
                },
                |status| {
                    let line = match status["text"].as_str() {
                        None => "there is none".to_owned(),
                        Some(line) => format!("it is \"{line}\""),
                    };
                    format!(
                        "Expected the status line {}to match {}, {line}",
                        not(NOT),
                        show(&text)
                    )
                },
            )
            .await
        }))
    }
}

impl<'a, S: Buttons + ?Sized> Expectation<'a, S> {
    /// The message has a button with this label; for a thread or a conversation, the agent's
    /// latest message there.
    pub fn to_have_button(self, label: impl IntoArg) -> Button<'a, false> {
        self.button(label.into_arg())
    }
    /// Once the agent is quiet, there is no such button.
    pub fn not_to_have_button(self, label: impl IntoArg) -> Button<'a, true> {
        self.button(label.into_arg())
    }
    fn button<const NOT: bool>(self, label: Value) -> Button<'a, NOT> {
        let subject = self.subject;
        Button(Check::new(move |options| async move {
            check_text(&label)?;
            let controls = |entry: &Value| {
                items(entry["controls"].clone())
                    .iter()
                    .map(|control| control.as_str().unwrap_or("").to_owned())
                    .collect::<Vec<_>>()
            };
            settle(
                subject,
                NOT,
                false,
                &options,
                || async {
                    let entries = items(subject.read_entries().await?);
                    Ok(match subject.entry_id() {
                        Some(id) => entries
                            .iter()
                            .filter(|entry| text_of(entry, "id") == id)
                            .flat_map(controls)
                            .collect(),
                        None => entries
                            .iter()
                            .rfind(|entry| text_of(&entry["author"], "kind") == "app")
                            .map(controls)
                            .unwrap_or_default(),
                    })
                },
                |controls| controls.iter().any(|control| text_matches(control, &label)),
                |controls| {
                    format!(
                        "Expected {} button matching {}. Buttons there: {}",
                        no_or(NOT, "a"),
                        show(&label),
                        if controls.is_empty() {
                            "none".to_owned()
                        } else {
                            controls.join(", ")
                        }
                    )
                },
            )
            .await
        }))
    }
}

impl<'a, S: Reactions + ?Sized> Expectation<'a, S> {
    /// The message has this reaction (`"eyes"` or `":eyes:"`), by `by` if it is given.
    pub fn to_have_reaction(self, emoji: &str) -> Reaction<'a, false> {
        self.reaction(emoji)
    }
    /// Once the agent is quiet, the message has no such reaction (by `by`, if given).
    pub fn not_to_have_reaction(self, emoji: &str) -> Reaction<'a, true> {
        self.reaction(emoji)
    }
    fn reaction<const NOT: bool>(self, emoji: &str) -> Reaction<'a, NOT> {
        let subject = self.subject;
        let name = emoji.strip_prefix(':').unwrap_or(emoji);
        let name = name.strip_suffix(':').unwrap_or(name).to_owned();
        Reaction(Check::new(move |options| async move {
            let by = options.get("by").clone();
            let by_whom = if by.is_null() {
                String::new()
            } else {
                format!(" by {}", name_of(&by))
            };
            settle(
                subject,
                NOT,
                false,
                &options,
                || async { Ok(items(subject.read_reactions().await?)) },
                |reactions| {
                    reactions.iter().any(|reaction| {
                        text_of(reaction, "emoji") == name
                            && (by.is_null()
                                || items(reaction["by"].clone())
                                    .iter()
                                    .any(|author| from_matches(author, &by)))
                    })
                },
                |reactions| {
                    let there: Vec<String> = reactions
                        .iter()
                        .map(|reaction| {
                            let who: Vec<String> = items(reaction["by"].clone())
                                .iter()
                                .map(|author| text_of(author, "name").to_owned())
                                .collect();
                            format!(":{}: by {}", text_of(reaction, "emoji"), who.join(", "))
                        })
                        .collect();
                    format!(
                        "Expected {} :{name}: reaction{by_whom}. Reactions there: {}",
                        no_or(NOT, "a"),
                        if there.is_empty() {
                            "none".to_owned()
                        } else {
                            there.join("; ")
                        }
                    )
                },
            )
            .await
        }))
    }
}

impl<'a, S: Modals + ?Sized> Expectation<'a, S> {
    /// Subject: a person. The agent opened a modal for them (it may be submitted by now), with this
    /// title; `Value::Null` for any title.
    pub fn to_have_opened_modal(self, title: impl IntoArg) -> OpenedModal<'a, false> {
        self.opened_modal(title.into_arg())
    }
    /// Once the agent is quiet, it opened no such modal for them.
    pub fn not_to_have_opened_modal(self, title: impl IntoArg) -> OpenedModal<'a, true> {
        self.opened_modal(title.into_arg())
    }
    fn opened_modal<const NOT: bool>(self, title: Value) -> OpenedModal<'a, NOT> {
        let subject = self.subject;
        OpenedModal(Check::new(move |options| async move {
            check_text(&title)?;
            let titled = if title.is_null() {
                String::new()
            } else {
                format!(" titled {}", show(&title))
            };
            settle(
                subject,
                NOT,
                false,
                &options,
                || async { Ok(items(subject.read_modals().await?)) },
                |modals| {
                    modals
                        .iter()
                        .any(|modal| text_matches(text_of(modal, "title"), &title))
                },
                |modals| {
                    let opened: Vec<String> = modals
                        .iter()
                        .map(|modal| modal["title"].to_string())
                        .collect();
                    format!(
                        "Expected {} modal{titled} to have been opened. Opened: {}",
                        no_or(NOT, "a"),
                        if opened.is_empty() {
                            "none".to_owned()
                        } else {
                            opened.join(", ")
                        }
                    )
                },
            )
            .await
        }))
    }
}

impl<'a, S: Ephemeral + ?Sized> Expectation<'a, S> {
    /// Only this person can see the message.
    pub fn to_be_ephemeral_for(self, user: impl IntoArg) -> EphemeralFor<'a, false> {
        self.ephemeral_for(user.into_arg())
    }
    /// Someone else, or everyone, can see the message too.
    pub fn not_to_be_ephemeral_for(self, user: impl IntoArg) -> EphemeralFor<'a, true> {
        self.ephemeral_for(user.into_arg())
    }
    fn ephemeral_for<const NOT: bool>(self, user: Value) -> EphemeralFor<'a, NOT> {
        let subject = self.subject;
        EphemeralFor(Check::new(move |_| async move {
            let visible_to = subject.visible_to();
            let pass = !visible_to.is_null() && visible_to["id"] == user["id"];
            if pass != NOT {
                return Ok(());
            }
            let who = if visible_to.is_null() {
                "everyone can see it".to_owned()
            } else {
                format!("only {} can", text_of(&visible_to, "name"))
            };
            Err(Error::Expectation(format!(
                "Expected the message {}to be visible only to {}, {who}",
                not(NOT),
                name_of(&user)
            )))
        }))
    }
}

impl<'a, S: Comments + ?Sized> Expectation<'a, S> {
    /// Subject: a GitHub issue or pull request, a Linear issue or a Notion discussion (a page's
    /// comments are in its discussions). A comment from this author, matching `text` if it is given.
    pub fn to_have_comment_from(self, author: impl IntoArg) -> CommentFrom<'a, false> {
        self.comment_from(author.into_arg())
    }
    /// Once the agent is quiet, no comment from this author (matching `text`, if given).
    pub fn not_to_have_comment_from(self, author: impl IntoArg) -> CommentFrom<'a, true> {
        self.comment_from(author.into_arg())
    }
    fn comment_from<const NOT: bool>(self, author: Value) -> CommentFrom<'a, NOT> {
        let subject = self.subject;
        CommentFrom(Check::new(move |options| async move {
            let text = options.text("text")?;
            let expected = negated(
                NOT,
                format!("a comment from {}{}", name_of(&author), matching(&text)),
            );
            settle(
                subject,
                NOT,
                false,
                &options,
                || async { Ok(items(subject.read_comments().await?)) },
                |comments| {
                    comments
                        .iter()
                        .any(|comment| comment_by(comment, &author, &text))
                },
                |comments| {
                    format!(
                        "Expected {expected}. The conversation has:\n{}",
                        written(comments)
                    )
                },
            )
            .await
        }))
    }

    /// Exactly `count` comments from this author, checked once the agent is quiet.
    pub fn to_have_comments_from(
        self,
        author: impl IntoArg,
        count: usize,
    ) -> CommentsFrom<'a, false> {
        self.comments_from(author.into_arg(), count)
    }
    /// Any number of comments from this author but `count`, checked once the agent is quiet.
    pub fn not_to_have_comments_from(
        self,
        author: impl IntoArg,
        count: usize,
    ) -> CommentsFrom<'a, true> {
        self.comments_from(author.into_arg(), count)
    }
    fn comments_from<const NOT: bool>(self, author: Value, count: usize) -> CommentsFrom<'a, NOT> {
        let subject = self.subject;
        CommentsFrom(Check::new(move |options| async move {
            let theirs = |comments: &[Value]| {
                comments
                    .iter()
                    .filter(|comment| comment_by(comment, &author, &Value::Null))
                    .count()
            };
            settle(
                subject,
                NOT,
                true,
                &options,
                || async { Ok(items(subject.read_comments().await?)) },
                |comments| theirs(comments) == count,
                |comments| {
                    format!(
                        "Expected {}exactly {count} comments from {}, found {}:\n{}",
                        not(NOT),
                        name_of(&author),
                        theirs(comments),
                        written(comments)
                    )
                },
            )
            .await
        }))
    }
}

impl<'a, S: PullRequest + ?Sized> Expectation<'a, S> {
    /// Subject: a pull request. A comment on the diff, matched by every field that is given
    /// (`path`, `line`, `from`, `text`).
    pub fn to_have_review_comment(self) -> ReviewComment<'a, false> {
        self.review_comment()
    }
    /// Once the agent is quiet, no such comment on the diff.
    pub fn not_to_have_review_comment(self) -> ReviewComment<'a, true> {
        self.review_comment()
    }
    fn review_comment<const NOT: bool>(self) -> ReviewComment<'a, NOT> {
        let subject = self.subject;
        ReviewComment(Check::new(move |options| async move {
            let text = options.text("text")?;
            let (path, line, from) = (
                options.get("path").clone(),
                options.get("line").clone(),
                options.get("from").clone(),
            );
            let mut on = String::new();
            if let Some(path) = path.as_str() {
                on = format!(" on {path}");
                if !line.is_null() {
                    on += &format!(":{line}");
                }
            }
            if !from.is_null() {
                on += &format!(" from {}", name_of(&from));
            }
            on += &matching(&text);
            settle(
                subject,
                NOT,
                false,
                &options,
                || async { Ok(items(subject.read_review_comments().await?)) },
                |comments| {
                    comments.iter().any(|comment| {
                        (path.is_null() || comment["path"] == path)
                            && (line.is_null() || comment["line"] == line)
                            && from_matches(&comment["author"], &from)
                            && text_matches(comment_text(comment), &text)
                    })
                },
                |comments| {
                    format!(
                        "Expected {} comment on the diff{on}. The diff has:\n{}",
                        no_or(NOT, "a"),
                        listing(comments.iter().map(|comment| format!(
                            "{} on {}:{}: {}",
                            author_name(comment),
                            text_of(comment, "path"),
                            comment["line"],
                            text_of(comment, "body")
                        )))
                    )
                },
            )
            .await
        }))
    }

    /// Subject: a pull request. A review from this author, with this `state` if one is given.
    pub fn to_have_review_from(self, author: impl IntoArg) -> ReviewFrom<'a, false> {
        self.review_from(author.into_arg())
    }
    /// Once the agent is quiet, no review from this author (with this `state`, if given).
    pub fn not_to_have_review_from(self, author: impl IntoArg) -> ReviewFrom<'a, true> {
        self.review_from(author.into_arg())
    }
    fn review_from<const NOT: bool>(self, author: Value) -> ReviewFrom<'a, NOT> {
        let subject = self.subject;
        ReviewFrom(Check::new(move |options| async move {
            let state = options.get("state").clone();
            let with = state
                .as_str()
                .map(|state| format!(" with state {state}"))
                .unwrap_or_default();
            settle(
                subject,
                NOT,
                false,
                &options,
                || async { Ok(items(subject.read_reviews().await?)) },
                |reviews| {
                    reviews.iter().any(|review| {
                        from_matches(&review["author"], &author)
                            && (state.is_null() || review["state"] == state)
                    })
                },
                |reviews| {
                    format!(
                        "Expected {} review from {}{with}. Reviews there:\n{}",
                        no_or(NOT, "a"),
                        name_of(&author),
                        listing(reviews.iter().map(|review| {
                            let body = match text_of(review, "body") {
                                "" => String::new(),
                                body => format!(" {}", Value::from(body)),
                            };
                            format!(
                                "{}: {}{body}",
                                author_name(review),
                                text_of(review, "state")
                            )
                        }))
                    )
                },
            )
            .await
        }))
    }

    /// Subject: a pull request. It has been merged.
    pub fn to_be_merged(self) -> Merged<'a, false> {
        self.merged()
    }
    /// Once the agent is quiet, the pull request isn't merged.
    pub fn not_to_be_merged(self) -> Merged<'a, true> {
        self.merged()
    }
    fn merged<const NOT: bool>(self) -> Merged<'a, NOT> {
        let subject = self.subject;
        Merged(Check::new(move |options| async move {
            settle(
                subject,
                NOT,
                false,
                &options,
                || subject.read_merged(),
                |merged| merged.as_bool() == Some(true),
                |_| format!("Expected the pull request {}to be merged", not(NOT)),
            )
            .await
        }))
    }
}

impl<'a, S: CheckRuns + ?Sized> Expectation<'a, S> {
    /// Subject: a pull request or a commit. A check run of this name (or matching this pattern),
    /// in this `status` and with this `conclusion` if they are given.
    pub fn to_have_check_run(self, name: impl IntoArg) -> CheckRun<'a, false> {
        self.check_run(name.into_arg())
    }
    /// Once the agent is quiet, no such check run.
    pub fn not_to_have_check_run(self, name: impl IntoArg) -> CheckRun<'a, true> {
        self.check_run(name.into_arg())
    }
    fn check_run<const NOT: bool>(self, name: Value) -> CheckRun<'a, NOT> {
        let subject = self.subject;
        CheckRun(Check::new(move |options| async move {
            check_text(&name)?;
            let (status, conclusion) = (
                options.get("status").clone(),
                options.get("conclusion").clone(),
            );
            let parts: Vec<&str> = [status.as_str(), conclusion.as_str()]
                .into_iter()
                .flatten()
                .collect();
            let wanted = if parts.is_empty() {
                String::new()
            } else {
                format!(" ({})", parts.join(", "))
            };
            settle(
                subject,
                NOT,
                false,
                &options,
                || async { Ok(items(subject.read_check_runs().await?)) },
                |runs| {
                    runs.iter().any(|run| {
                        name_matches(text_of(run, "name"), &name)
                            && (status.is_null() || run["status"] == status)
                            && (conclusion.is_null() || run["conclusion"] == conclusion)
                    })
                },
                |runs| {
                    format!(
                        "Expected {} check run {}{wanted}. Check runs there:\n{}",
                        no_or(NOT, "a"),
                        show(&name),
                        listing(runs.iter().map(|run| {
                            let conclusion = run["conclusion"]
                                .as_str()
                                .map(|conclusion| format!(", {conclusion}"))
                                .unwrap_or_default();
                            format!(
                                "{}: {}{conclusion}",
                                text_of(run, "name"),
                                text_of(run, "status")
                            )
                        }))
                    )
                },
            )
            .await
        }))
    }
}

impl<'a, S: Labels + ?Sized> Expectation<'a, S> {
    /// Subject: an issue or a pull request. It has this label (in any case).
    pub fn to_have_label(self, name: &str) -> Label<'a, false> {
        self.label(name.to_owned())
    }
    /// Once the agent is quiet, it doesn't have this label.
    pub fn not_to_have_label(self, name: &str) -> Label<'a, true> {
        self.label(name.to_owned())
    }
    fn label<const NOT: bool>(self, name: String) -> Label<'a, NOT> {
        let subject = self.subject;
        Label(Check::new(move |options| async move {
            let labels = || async {
                Ok(items(subject.read_labels().await?)
                    .iter()
                    .map(|label| label.as_str().unwrap_or("").to_owned())
                    .collect::<Vec<_>>())
            };
            settle(
                subject,
                NOT,
                false,
                &options,
                labels,
                |labels| labels.iter().any(|label| same_name(label, &name)),
                |labels| {
                    format!(
                        "Expected {} label {}. Labels there: {}",
                        no_or(NOT, "the"),
                        Value::from(name.as_str()),
                        if labels.is_empty() {
                            "none".to_owned()
                        } else {
                            labels.join(", ")
                        }
                    )
                },
            )
            .await
        }))
    }
}

impl<'a, S: AgentSession + ?Sized> Expectation<'a, S> {
    /// Subject: a Linear agent session, or an issue (its latest session). The session's state.
    pub fn to_have_session_state(self, state: &str) -> SessionState<'a, false> {
        self.session_state(state.to_owned())
    }
    /// Once the agent is quiet, the session is in another state.
    pub fn not_to_have_session_state(self, state: &str) -> SessionState<'a, true> {
        self.session_state(state.to_owned())
    }
    fn session_state<const NOT: bool>(self, expected: String) -> SessionState<'a, NOT> {
        let subject = self.subject;
        SessionState(Check::new(move |options| async move {
            let current = |state: &Value| state.as_str().unwrap_or("").to_owned();
            settle(
                subject,
                NOT,
                false,
                &options,
                || subject.read_session_state(),
                |state| current(state) == expected,
                |state| {
                    format!(
                        "Expected the agent session {}to be {expected}, it is {}",
                        not(NOT),
                        current(state)
                    )
                },
            )
            .await
        }))
    }

    /// Subject: a Linear agent session, or an issue (its latest session). An activity of the
    /// agent's matching every field that is given (`type`, `from`, `text`): a person's turns
    /// (`prompt`) aren't what it published.
    pub fn to_have_activity(self) -> Activity<'a, false> {
        self.activity()
    }
    /// Once the agent is quiet, no such activity.
    pub fn not_to_have_activity(self) -> Activity<'a, true> {
        self.activity()
    }
    fn activity<const NOT: bool>(self) -> Activity<'a, NOT> {
        let subject = self.subject;
        Activity(Check::new(move |options| async move {
            let text = options.text("text")?;
            let (kind, from) = (options.get("type").clone(), options.get("from").clone());
            let mut wanted = kind.as_str().unwrap_or("activity").to_owned();
            if !from.is_null() {
                wanted += &format!(" from {}", name_of(&from));
            }
            wanted += &matching(&text);
            settle(
                subject,
                NOT,
                false,
                &options,
                || async {
                    Ok(items(subject.read_activities().await?)
                        .into_iter()
                        .filter(|activity| text_of(activity, "type") != "prompt")
                        .collect::<Vec<_>>())
                },
                |activities| {
                    activities.iter().any(|activity| {
                        (kind.is_null() || activity["type"] == kind)
                            && from_matches(&activity["author"], &from)
                            && text_matches(text_of(activity, "body"), &text)
                    })
                },
                |activities| {
                    format!(
                        "Expected {} {wanted}. The session has:\n{}",
                        no_or(NOT, "a"),
                        listing(activities.iter().map(|activity| format!(
                            "{} ({}): {}",
                            author_name(activity),
                            text_of(activity, "type"),
                            text_of(activity, "body")
                        )))
                    )
                },
            )
            .await
        }))
    }
}

impl<'a, S: Issue + ?Sized> Expectation<'a, S> {
    /// Subject: a Linear issue. It is delegated to this app, or (with `Value::Null`) to none.
    pub fn to_be_delegated_to(self, app: impl IntoArg) -> DelegatedTo<'a, false> {
        DelegatedTo(self.held_by(app.into_arg(), "delegated", S::read_delegate, false))
    }
    /// Once the agent is quiet, it is delegated to another app (or to none).
    pub fn not_to_be_delegated_to(self, app: impl IntoArg) -> DelegatedTo<'a, true> {
        DelegatedTo(self.held_by(app.into_arg(), "delegated", S::read_delegate, true))
    }
    /// Subject: a Linear issue. It is assigned to this person, or (with `Value::Null`) to no one.
    pub fn to_be_assigned_to(self, user: impl IntoArg) -> AssignedTo<'a, false> {
        AssignedTo(self.held_by(user.into_arg(), "assigned", S::read_assignee, false))
    }
    /// Once the agent is quiet, it is assigned to someone else (or to no one).
    pub fn not_to_be_assigned_to(self, user: impl IntoArg) -> AssignedTo<'a, true> {
        AssignedTo(self.held_by(user.into_arg(), "assigned", S::read_assignee, true))
    }
    /// Who an issue is delegated or assigned to, compared by id.
    fn held_by(
        self,
        expected: Value,
        how: &'static str,
        read: fn(&S) -> BoxFuture<'_, Result<Value>>,
        negate: bool,
    ) -> Check<'a> {
        let subject = self.subject;
        Check::new(move |options| async move {
            let name = |holder: &Value| {
                if holder.is_null() {
                    "no one".to_owned()
                } else {
                    name_of(holder).to_owned()
                }
            };
            settle(
                subject,
                negate,
                false,
                &options,
                || read(subject),
                |holder| {
                    if expected.is_null() {
                        holder.is_null()
                    } else {
                        !holder.is_null() && holder["id"] == expected["id"]
                    }
                },
                |holder| {
                    format!(
                        "Expected the issue {}to be {how} to {}, it is {how} to {}",
                        not(negate),
                        name(&expected),
                        name(holder)
                    )
                },
            )
            .await
        })
    }

    /// Subject: a Linear issue. Its workflow state, by name (in any case).
    pub fn to_have_state(self, name: &str) -> WorkflowState<'a, false> {
        self.workflow_state(name.to_owned())
    }
    /// Once the agent is quiet, the issue is in another workflow state.
    pub fn not_to_have_state(self, name: &str) -> WorkflowState<'a, true> {
        self.workflow_state(name.to_owned())
    }
    fn workflow_state<const NOT: bool>(self, name: String) -> WorkflowState<'a, NOT> {
        let subject = self.subject;
        WorkflowState(Check::new(move |options| async move {
            settle(
                subject,
                NOT,
                false,
                &options,
                || async { Ok(text_of(&subject.read_workflow_state().await?, "name").to_owned()) },
                |current| same_name(current, &name),
                |current| {
                    format!(
                        "Expected the issue {}to be in {}, it is in {}",
                        not(NOT),
                        Value::from(name.as_str()),
                        Value::from(current.as_str())
                    )
                },
            )
            .await
        }))
    }
}

impl<'a, S: Page + ?Sized> Expectation<'a, S> {
    /// Subject: a Notion page. A block (at any depth) whose text matches.
    pub fn to_have_block(self, text: impl IntoArg) -> Block<'a, false> {
        self.block(text.into_arg())
    }
    /// Once the agent is quiet, no block of the page matches.
    pub fn not_to_have_block(self, text: impl IntoArg) -> Block<'a, true> {
        self.block(text.into_arg())
    }
    fn block<const NOT: bool>(self, text: Value) -> Block<'a, NOT> {
        let subject = self.subject;
        Block(Check::new(move |options| async move {
            check_text(&text)?;
            settle(
                subject,
                NOT,
                false,
                &options,
                || async { Ok(block_texts(&items(subject.read_blocks().await?))) },
                |texts| texts.iter().any(|line| text_matches(line, &text)),
                |texts| {
                    format!(
                        "Expected the page {}to have a block matching {}. Its blocks:\n{}",
                        not(NOT),
                        show(&text),
                        listing(texts.iter().cloned())
                    )
                },
            )
            .await
        }))
    }

    /// Subject: a Notion page. A property has this value, compared as JSON.
    pub fn to_have_property_value(
        self,
        name: &str,
        value: impl IntoArg,
    ) -> PropertyValue<'a, false> {
        self.property_value(name.to_owned(), value.into_arg())
    }
    /// Once the agent is quiet, the property has another value.
    pub fn not_to_have_property_value(
        self,
        name: &str,
        value: impl IntoArg,
    ) -> PropertyValue<'a, true> {
        self.property_value(name.to_owned(), value.into_arg())
    }
    fn property_value<const NOT: bool>(
        self,
        name: String,
        expected: Value,
    ) -> PropertyValue<'a, NOT> {
        let subject = self.subject;
        PropertyValue(Check::new(move |options| async move {
            // `String(expected)` in matchers-core: text as it is, anything else as JSON.
            let shown = expected
                .as_str()
                .map_or_else(|| expected.to_string(), str::to_owned);
            settle(
                subject,
                NOT,
                false,
                &options,
                || subject.read_property(&name),
                |value| *value == expected,
                |value| format!("Expected {name} {}to be {shown}, it is {value}", not(NOT)),
            )
            .await
        }))
    }
}

/// A delivery's attempts that were (`forged`) or weren't sent with a wrong signature.
fn attempts(list: Value, forged: bool) -> Vec<Value> {
    items(list)
        .into_iter()
        .filter(|attempt| attempt["forgedSignature"].as_bool().unwrap_or(false) == forged)
        .collect()
}

impl<'a, S: Delivery + ?Sized> Expectation<'a, S> {
    /// The agent answered the delivery with 2xx, within the platform's window; with `within`,
    /// that fast.
    pub fn to_be_accepted(self) -> Accepted<'a, false> {
        self.accepted()
    }
    /// Once the agent is quiet, the delivery wasn't accepted (that fast, with `within`).
    pub fn not_to_be_accepted(self) -> Accepted<'a, true> {
        self.accepted()
    }
    fn accepted<const NOT: bool>(self) -> Accepted<'a, NOT> {
        let subject = self.subject;
        Accepted(Check::new(move |options| async move {
            let within = match options.get("within") {
                Value::Null => None,
                within => Some(parse_duration(within)?),
            };
            let id = subject.delivery_id();
            settle(
                subject,
                NOT,
                false,
                &options,
                || async {
                    let first = attempts(subject.read_attempts().await?, false);
                    Ok(first.into_iter().next().unwrap_or(Value::Null))
                },
                // Accepted, and with `within`, accepted that fast: the platform's window is only the outer limit.
                |attempt| {
                    text_of(attempt, "status") == "acknowledged"
                        && within.is_none_or(|within| {
                            attempt["durationMs"].as_f64().unwrap_or(0.0) <= within
                        })
                },
                |attempt| {
                    let within = within
                        .map(|within| format!(" within {within}ms"))
                        .unwrap_or_default();
                    let http = attempt["responseStatus"]
                        .as_i64()
                        .map(|status| format!(" (HTTP {status})"))
                        .unwrap_or_default();
                    let took = attempt["durationMs"]
                        .as_f64()
                        .map(|ms| format!(" after {ms}ms"))
                        .unwrap_or_default();
                    let status = attempt["status"].as_str().unwrap_or("missing");
                    format!(
                        "Expected delivery {id} {}to be accepted{within}, its first attempt is {status}{http}{took}",
                        not(NOT)
                    )
                },
            )
            .await
        }))
    }

    /// A forged delivery (`resend` with a bad signature) was refused by the agent with a 4xx.
    pub fn to_be_rejected(self) -> Rejected<'a, false> {
        self.rejected()
    }
    /// Once the agent is quiet, the forged attempt wasn't refused with a 4xx.
    pub fn not_to_be_rejected(self) -> Rejected<'a, true> {
        self.rejected()
    }
    fn rejected<const NOT: bool>(self) -> Rejected<'a, NOT> {
        let subject = self.subject;
        Rejected(Check::new(move |options| async move {
            let id = subject.delivery_id();
            settle(
                subject,
                NOT,
                false,
                &options,
                || async {
                    let forged = attempts(subject.read_attempts().await?, true);
                    Ok(forged.into_iter().next_back().unwrap_or(Value::Null))
                },
                |attempt| {
                    text_of(attempt, "status") == "failed"
                        && attempt["responseStatus"]
                            .as_i64()
                            .is_some_and(|status| (400..500).contains(&status))
                },
                |attempt| match attempt {
                    Value::Null => format!(
                        "Expected delivery {id} to be rejected, but no forged attempt was sent. Call delivery.resend().bad_signature(true) first"
                    ),
                    attempt => format!(
                        "Expected the forged attempt of delivery {id} {}to be rejected with a 4xx, the agent answered {}",
                        not(NOT),
                        attempt["responseStatus"]
                            .as_i64()
                            .map_or_else(|| text_of(attempt, "status").to_owned(), |status| status.to_string())
                    ),
                },
            )
            .await
        }))
    }

    /// The delivery needed retries; with `times`, exactly that many, checked once the agent is quiet.
    pub fn to_be_retried(self) -> Retried<'a, false> {
        self.retried()
    }
    /// Once the agent is quiet, the delivery wasn't retried (that many `times`, if given).
    pub fn not_to_be_retried(self) -> Retried<'a, true> {
        self.retried()
    }
    fn retried<const NOT: bool>(self) -> Retried<'a, NOT> {
        let subject = self.subject;
        Retried(Check::new(move |options| async move {
            let times = options.number("times");
            let id = subject.delivery_id();
            settle(
                subject,
                NOT,
                times.is_some(),
                &options,
                || async { Ok(attempts(subject.read_attempts().await?, false).len() as i64 - 1) },
                |retries| times.map_or(*retries > 0, |times| *retries == times),
                |retries| {
                    let wanted = times
                        .map(|times| format!(" {times} times"))
                        .unwrap_or_default();
                    format!(
                        "Expected delivery {id} {}to be retried{wanted}, it was retried {retries} times",
                        not(NOT)
                    )
                },
            )
            .await
        }))
    }
}

impl<'a, S: Calls + ?Sized> Expectation<'a, S> {
    /// Subject: a channel's fixture. The agent made this API call (a name, or a pattern); with
    /// `times`, exactly that many, checked once the agent is quiet; with `error`, refused so.
    pub fn to_have_received_call(self, operation: impl IntoArg) -> ReceivedCall<'a, false> {
        self.received_call(operation.into_arg())
    }
    /// Once the agent is quiet, it made no such call (not that many `times`, if given).
    pub fn not_to_have_received_call(self, operation: impl IntoArg) -> ReceivedCall<'a, true> {
        self.received_call(operation.into_arg())
    }
    fn received_call<const NOT: bool>(self, operation: Value) -> ReceivedCall<'a, NOT> {
        let subject = self.subject;
        ReceivedCall(Check::new(move |options| async move {
            check_text(&operation)?;
            let times = options.number("times");
            let error = options.get("error").clone();
            let matching = |calls: &[Value]| {
                calls
                    .iter()
                    .filter(|call| name_matches(operation_of(call), &operation))
                    .count()
            };
            settle(
                subject,
                NOT,
                times.is_some(),
                &options,
                || async { Ok(items(subject.read_calls(error.clone()).await?)) },
                |calls| {
                    let found = matching(calls);
                    times.map_or(found > 0, |times| found as i64 == times)
                },
                |calls| {
                    let times = times
                        .map(|times| format!(" {times} times"))
                        .unwrap_or_default();
                    let refused = error
                        .as_str()
                        .map(|error| format!(" with error {error}"))
                        .unwrap_or_default();
                    format!(
                        "Expected the agent {}to call {}{times}{refused}, found {}. Its calls:\n{}",
                        not(NOT),
                        show(&operation),
                        matching(calls),
                        listing(calls.iter().map(|call| match text_of(call, "error") {
                            "" => operation_of(call).to_owned(),
                            error => format!("{} → {error}", operation_of(call)),
                        }))
                    )
                },
            )
            .await
        }))
    }
}

// --- The model (decision 0029) -------------------------------------------------------------------

check!(
    /// [`Expectation::to_have_sent`].
    Sent { ordered("ordered"): bool }
);
check!(
    /// [`Expectation::to_have_sent_file`].
    SentFile {}
);
check!(
    /// [`Expectation::to_have_sent_secrets`].
    SentSecrets {}
);
check!(
    /// [`Expectation::to_have_offered_tool`].
    OfferedTool {}
);
check!(
    /// [`Expectation::to_have_sent_tool_result`].
    SentToolResult { text("text"): impl IntoArg }
);
check!(
    /// [`Expectation::to_be_aborted`].
    Aborted {}
);
check!(
    /// [`Expectation::to_have_answered`].
    Answered counts { times("times"): usize }
);

/// Text as the server compares it: mentions gone, whitespace collapsed, case ignored.
fn normalised(text: &str) -> String {
    let mentions = regex::Regex::new(r"<[@#!][^>]*>|(?:^|\s)@[\w.-]+").expect("a pattern");
    let spaced = mentions.replace_all(text, " ");
    spaced
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Whether a request's text has every wanted piece, in order when asked.
fn sent_in(text: &str, wanted: &[Value], ordered: bool) -> bool {
    let haystack = normalised(text);
    let mut from = 0;
    for piece in wanted {
        if piece.get("source").is_some() {
            if !text_matches(text, piece) {
                return false;
            }
            continue;
        }
        let needle = normalised(piece.as_str().unwrap_or_else(|| text_of(piece, "text")));
        let start = if ordered { from } else { 0 };
        let Some(at) = haystack.get(start..).and_then(|rest| rest.find(&needle)) else {
            return false;
        };
        from = start + at + needle.len();
    }
    true
}

/// A request's text, one line, short enough for a failure message.
fn excerpt(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() > 120 {
        format!("{}…", line.chars().take(119).collect::<String>())
    } else {
        line
    }
}

impl<'a, S: ModelCalls + ?Sized> Expectation<'a, S> {
    /// Subject: the openai fixture, a script, or a call. The agent sent the model this text (a
    /// string, a pattern, or a list of them: with `ordered`, in that order, as thread history is).
    pub fn to_have_sent(self, expected: impl IntoArg) -> Sent<'a, false> {
        self.sent(expected.into_arg())
    }
    /// Once the agent is quiet, it sent the model none of it: no text from a channel it shouldn't read.
    pub fn not_to_have_sent(self, expected: impl IntoArg) -> Sent<'a, true> {
        self.sent(expected.into_arg())
    }
    fn sent<const NOT: bool>(self, expected: Value) -> Sent<'a, NOT> {
        let subject = self.subject;
        Sent(Check::new(move |options| async move {
            let list = matches!(expected, Value::Array(_));
            let wanted = match &expected {
                Value::Array(items) => items.clone(),
                one => vec![one.clone()],
            };
            let ordered = options.get("ordered").as_bool().unwrap_or(list);
            settle(
                subject,
                NOT,
                false,
                &options,
                || async {
                    Ok(items(subject.read_model_calls().await?)
                        .iter()
                        .map(|call| text_of(&call["request"], "text").to_owned())
                        .collect::<Vec<_>>())
                },
                |texts| texts.iter().any(|text| sent_in(text, &wanted, ordered)),
                |texts| {
                    let shown: Vec<String> = wanted.iter().map(show).collect();
                    let order = if ordered && wanted.len() > 1 {
                        " in that order"
                    } else {
                        ""
                    };
                    let sent = if texts.is_empty() {
                        "It made no model call.".to_owned()
                    } else {
                        format!(
                            "What it sent, newest first:\n{}",
                            listing(texts.iter().rev().map(|text| excerpt(text)))
                        )
                    };
                    format!(
                        "Expected the agent {}to send the model {}{order}. {sent}",
                        not(NOT),
                        shown.join(", then ")
                    )
                },
            )
            .await
        }))
    }

    /// Subject: a call (or the fixture, a script). The agent offered the model this tool.
    pub fn to_have_offered_tool(self, name: &str) -> OfferedTool<'a, false> {
        let subject = self.subject;
        let name = name.to_owned();
        OfferedTool(Check::new(move |options| async move {
            settle(
                subject,
                false,
                false,
                &options,
                || async {
                    Ok(items(subject.read_model_calls().await?)
                        .iter()
                        .flat_map(|call| items(call["request"]["tools"].clone()))
                        .collect::<Vec<_>>())
                },
                |tools| tools.iter().any(|tool| tool_name(tool) == name),
                |tools| {
                    let mut offered: Vec<&str> = tools.iter().map(tool_name).collect();
                    offered.sort_unstable();
                    offered.dedup();
                    format!(
                        "Expected the agent to offer the model the tool {name:?}, it offered {}",
                        if offered.is_empty() {
                            "none".to_owned()
                        } else {
                            offered.join(", ")
                        }
                    )
                },
            )
            .await
        }))
    }
}

impl<'a, S: ModelCalls + ?Sized> Expectation<'a, S> {
    /// Subject: the openai fixture, a script, or a call. The agent sent the model this image, file
    /// or audio, compared by its SHA-256: a fixture file's path (read as a media source is, from
    /// the files root) or its bytes (`Vec<u8>`).
    pub fn to_have_sent_file(self, file: impl IntoArg) -> SentFile<'a, false> {
        self.sent_file(file.into_arg())
    }
    /// Once the agent is quiet, it sent the model no part with this file's hash.
    pub fn not_to_have_sent_file(self, file: impl IntoArg) -> SentFile<'a, true> {
        self.sent_file(file.into_arg())
    }
    fn sent_file<const NOT: bool>(self, file: Value) -> SentFile<'a, NOT> {
        let subject = self.subject;
        SentFile(Check::new(move |options| async move {
            let read = read_media(&file)?;
            let bytes = STANDARD
                .decode(text_of(&read, "content"))
                .map_err(|_| Error::Invalid(format!("Not a path or bytes: {file}")))?;
            let sha256 = hex(&Sha256::digest(&bytes));
            let named = match text_of(&read, "name") {
                "" => "these bytes",
                name => name,
            };
            settle(
                subject,
                NOT,
                false,
                &options,
                || async {
                    Ok(items(subject.read_model_calls().await?)
                        .iter()
                        .flat_map(|call| {
                            let request = &call["request"];
                            items(request["messages"].clone())
                                .iter()
                                .flat_map(|message| items(message["parts"].clone()))
                                .chain(request.get("file").filter(|file| file.is_object()).cloned())
                                .collect::<Vec<_>>()
                        })
                        .collect::<Vec<_>>())
                },
                |parts| parts.iter().any(|part| text_of(part, "sha256") == sha256),
                |parts| {
                    let sent = if parts.is_empty() {
                        "It sent no image, file or audio.".to_owned()
                    } else {
                        format!(
                            "What it sent, newest first:\n{}",
                            listing(parts.iter().rev().map(part_of))
                        )
                    };
                    format!(
                        "Expected the agent {}to send the model {named} ({}, sha256 {}). {sent}",
                        not(NOT),
                        size_of(bytes.len()),
                        &sha256[..12]
                    )
                },
            )
            .await
        }))
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn size_of(bytes: usize) -> String {
    format!("{bytes} {}", if bytes == 1 { "byte" } else { "bytes" })
}

/// A part as a failure lists it: type, media type, size and hash, or where it is when the fake didn't read it.
fn part_of(part: &Value) -> String {
    let field = |name: &str| Some(text_of(part, name)).filter(|value| !value.is_empty());
    let size = part["bytes"]
        .as_u64()
        .and_then(|bytes| usize::try_from(bytes).ok())
        .map(size_of);
    let where_ = match field("sha256") {
        Some(sha256) => Some(format!("sha256 {}", sha256.get(..12).unwrap_or(sha256))),
        None => field("url")
            .map(str::to_owned)
            .or_else(|| field("fileId").map(|id| format!("file {id}"))),
    };
    [
        field("type").map(str::to_owned),
        field("mediaType").map(str::to_owned),
        size,
        where_,
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(", ")
}

/// A tool as a request offered it: a function by its name, a built-in by its type.
fn tool_name(tool: &Value) -> &str {
    match text_of(tool, "name") {
        "" => text_of(tool, "type"),
        name => name,
    }
}

impl<'a, S: SentSecretsRead + ?Sized> Expectation<'a, S> {
    /// Subject: the openai fixture. A secret channelstack knows was sent to the model (its kind, never its value).
    pub fn to_have_sent_secrets(self) -> SentSecrets<'a, false> {
        self.secrets()
    }
    /// Once the agent is quiet, no token, signing secret or key reached the model.
    pub fn not_to_have_sent_secrets(self) -> SentSecrets<'a, true> {
        self.secrets()
    }
    fn secrets<const NOT: bool>(self) -> SentSecrets<'a, NOT> {
        let subject = self.subject;
        SentSecrets(Check::new(move |options| async move {
            settle(
                subject,
                NOT,
                false,
                &options,
                || async { Ok(items(subject.read_sent_secrets().await?)) },
                |sent| !sent.is_empty(),
                |sent| {
                    if sent.is_empty() {
                        return "Expected the agent to send the model a secret, it sent none"
                            .to_owned();
                    }
                    format!(
                        "Expected the agent not to send the model any secret, it sent:\n{}",
                        listing(sent.iter().map(|one| {
                            let kinds: Vec<String> = items(one["kinds"].clone())
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect();
                            format!("{}: {}", text_of(one, "call"), kinds.join(", "))
                        }))
                    )
                },
            )
            .await
        }))
    }
}

impl<'a, S: ModelToolCalls + ?Sized> Expectation<'a, S> {
    /// Subject: the openai fixture or a script. The agent ran the model's call to this tool and
    /// sent back its result (with this `text`, if given).
    pub fn to_have_sent_tool_result(self, name: &str) -> SentToolResult<'a, false> {
        let subject = self.subject;
        let name = name.to_owned();
        SentToolResult(Check::new(move |options| async move {
            let text = options.text("text")?;
            settle(
                subject,
                false,
                false,
                &options,
                || async { Ok(items(subject.read_tool_calls(&name).await?)) },
                |calls| {
                    calls
                        .iter()
                        .any(|call| call.get("result").is_some_and(|result| text_matches(text_of(result, "text"), &text)))
                },
                |calls| {
                    let answered = calls.iter().filter(|call| call.get("result").is_some()).count();
                    format!(
                        "Expected the agent to send back a result for {name:?}{}. The model called it {} times; {answered} got a result",
                        if text.is_null() { String::new() } else { format!(" with {}", show(&text)) },
                        calls.len()
                    )
                },
            )
            .await
        }))
    }
}

impl<'a, S: ModelCallRefresh + ?Sized> Expectation<'a, S> {
    /// Subject: a model call. The agent hung up before the answer was complete: Stop, or its own timeout.
    pub fn to_be_aborted(self) -> Aborted<'a, false> {
        let subject = self.subject;
        Aborted(Check::new(move |options| async move {
            settle(
                subject,
                false,
                false,
                &options,
                || async { Ok(subject.read_call().await?["response"].clone()) },
                |response| response["aborted"].as_bool().unwrap_or(false),
                |response| match text_of(response, "end") {
                    "" => "Expected the model call to be aborted by the agent, it is still going"
                        .to_owned(),
                    end => format!(
                        "Expected the model call to be aborted by the agent, it ended {end}"
                    ),
                },
            )
            .await
        }))
    }
}

impl<'a, S: ScriptRefresh + ?Sized> Expectation<'a, S> {
    /// Subject: a script. It answered calls; with `times`, exactly that many, checked once the agent is quiet.
    pub fn to_have_answered(self) -> Answered<'a, false> {
        self.answered()
    }
    /// Once the agent is quiet, the script answered no call (not that many `times`, if given).
    pub fn not_to_have_answered(self) -> Answered<'a, true> {
        self.answered()
    }
    fn answered<const NOT: bool>(self) -> Answered<'a, NOT> {
        let subject = self.subject;
        Answered(Check::new(move |options| async move {
            let times = options.number("times");
            settle(
                subject,
                NOT,
                times.is_some(),
                &options,
                || async { subject.read_script().await },
                |script| {
                    let used = script["used"].as_i64().unwrap_or(0);
                    times.map_or(used > 0, |times| used == times)
                },
                |script| {
                    let wanted = times.map_or_else(
                        || "a call".to_owned(),
                        |times| format!("{times} {}", if times == 1 { "call" } else { "calls" }),
                    );
                    let problems = items(script["problems"].clone());
                    let problems = if problems.is_empty() {
                        String::new()
                    } else {
                        format!(
                            ". Its problems:\n{}",
                            listing(problems.iter().filter_map(Value::as_str).map(str::to_owned))
                        )
                    };
                    format!(
                        "Expected script {} {}to answer {wanted}, it answered {}{problems}",
                        text_of(script, "id"),
                        not(NOT),
                        script["used"].as_i64().unwrap_or(0)
                    )
                },
            )
            .await
        }))
    }
}
