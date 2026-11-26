//! What each matcher reads, and which handles can be read for it. A matcher is a method of
//! `Expectation<S>` only where `S` has the read it needs, so a check on the wrong subject doesn't
//! compile. Each read is one plain SDK method, as in `integrations/matchers-core`.

use std::future::IntoFuture;

use serde_json::Value;

use crate::runtime::client::{BoxFuture, Handle, IntoArg};
use crate::runtime::error::Result;
use crate::runtime::wait::QuietState;
use crate::{
    GitHubCommit, GitHubIssue, GitHubPullRequest, GoogleThread, LinearAgentSession, LinearIssue,
    NotionDiscussion, NotionPage, ResendThread, SlackConversation, SlackMessage, SlackThread,
    SlackUser,
};

/// Something checked in a session: every handle. A check that waits for quiet asks its session.
pub trait Subject: Sync {
    /// Whether the agent is quiet in the subject's session.
    fn quiet(&self) -> BoxFuture<'_, Result<QuietState>>;
}

impl<H: Handle + Sync + ?Sized> Subject for H {
    fn quiet(&self) -> BoxFuture<'_, Result<QuietState>> {
        Box::pin(self.ctx().quiet())
    }
}

/// What was said: a thread's replies, or everything in a conversation (a DM), as its transcript
/// has it. Each is `{ author, text, stream?: { state } }`.
pub trait Said: Subject {
    fn read_said(&self) -> BoxFuture<'_, Result<Value>>;
}

/// The messages directly in a conversation, outside any thread.
pub trait ChannelMessages: Subject {
    fn read_messages(&self) -> BoxFuture<'_, Result<Value>>;
}

/// What a person sees: `{ entries: [{ author, text, controls, … }] }`. `viewer` (Slack only) reads
/// it as that person sees it; `null` as anyone does.
pub trait Readable: Subject {
    fn read_transcript(&self, viewer: Value) -> BoxFuture<'_, Result<Value>>;
}

/// What the agent is doing in a thread: `{ state, text? }`.
pub trait Status: Subject {
    fn read_status(&self) -> BoxFuture<'_, Result<Value>>;
}

/// Where a message's buttons are: the entries of a transcript, and for a message, which one is it.
/// Without one, the buttons are those of the app's latest entry.
pub trait Buttons: Subject {
    fn read_entries(&self) -> BoxFuture<'_, Result<Value>>;
    fn entry_id(&self) -> Option<String>;
}

/// A message's reactions: `[{ emoji, by: [author] }]`.
pub trait Reactions: Subject {
    fn read_reactions(&self) -> BoxFuture<'_, Result<Value>>;
}

/// The modals the agent opened for a person: `[{ title }]`.
pub trait Modals: Subject {
    fn read_modals(&self) -> BoxFuture<'_, Result<Value>>;
}

/// Who alone can see a message, or `null` when everyone can.
pub trait Ephemeral: Subject {
    fn visible_to(&self) -> Value;
}

/// A conversation's comments: `[{ author, body }]` (GitHub, Linear) or `[{ author, text }]` (Notion).
pub trait Comments: Subject {
    fn read_comments(&self) -> BoxFuture<'_, Result<Value>>;
}

/// A pull request's comments on the diff, its reviews, and whether it was merged.
pub trait PullRequest: Subject {
    fn read_review_comments(&self) -> BoxFuture<'_, Result<Value>>;
    fn read_reviews(&self) -> BoxFuture<'_, Result<Value>>;
    fn read_merged(&self) -> BoxFuture<'_, Result<Value>>;
}

/// The check runs of a pull request or a commit: `[{ name, status, conclusion? }]`.
pub trait CheckRuns: Subject {
    fn read_check_runs(&self) -> BoxFuture<'_, Result<Value>>;
}

/// The names of an issue's or a pull request's labels.
pub trait Labels: Subject {
    fn read_labels(&self) -> BoxFuture<'_, Result<Value>>;
}

/// A Linear agent session, or an issue's latest one: its state (`"no session"` when there is
/// none) and its activities (`[]`).
pub trait AgentSession: Subject {
    fn read_session_state(&self) -> BoxFuture<'_, Result<Value>>;
    fn read_activities(&self) -> BoxFuture<'_, Result<Value>>;
}

/// A Linear issue: who it is delegated and assigned to (`null` for no one), and its workflow state.
pub trait Issue: Subject {
    fn read_delegate(&self) -> BoxFuture<'_, Result<Value>>;
    fn read_assignee(&self) -> BoxFuture<'_, Result<Value>>;
    fn read_workflow_state(&self) -> BoxFuture<'_, Result<Value>>;
}

/// A Notion page: its blocks, and the value of a property.
pub trait Page: Subject {
    fn read_blocks(&self) -> BoxFuture<'_, Result<Value>>;
    fn read_property(&self, name: &str) -> BoxFuture<'_, Result<Value>>;
}

/// A delivery to the agent: its id, and its attempts read again.
pub trait Delivery: Subject {
    fn delivery_id(&self) -> String;
    fn read_attempts(&self) -> BoxFuture<'_, Result<Value>>;
}

/// A channel's fixture: the agent's API calls, only those refused with `error` when it isn't `null`.
pub trait Calls: Subject {
    fn read_calls(&self, error: Value) -> BoxFuture<'_, Result<Value>>;
}

/// A read that is one method of the handle, called as it is.
macro_rules! reads {
    ($trait:ident :: $read:ident => $method:ident for $($handle:ty),+) => {$(
        impl $trait for $handle {
            fn $read(&self) -> BoxFuture<'_, Result<Value>> {
                Box::pin(self.$method().into_future())
            }
        }
    )+};
}

reads!(ChannelMessages::read_messages => messages for SlackConversation);
reads!(Status::read_status => status for SlackThread);
reads!(Reactions::read_reactions => reactions for SlackMessage);
reads!(Modals::read_modals => modals for SlackUser);
reads!(Comments::read_comments => comments for GitHubIssue, GitHubPullRequest, LinearIssue, NotionDiscussion);
reads!(CheckRuns::read_check_runs => check_runs for GitHubPullRequest, GitHubCommit);
reads!(Labels::read_labels => labels for GitHubIssue, GitHubPullRequest, LinearIssue);

// A thread's replies: Slack's, and an email thread's (Resend, Gmail), as in matchers-core.
reads!(Said::read_said => replies for SlackThread, ResendThread, GoogleThread);

impl Said for SlackConversation {
    fn read_said(&self) -> BoxFuture<'_, Result<Value>> {
        Box::pin(async {
            let transcript = self.transcript().await?;
            // A transcript entry says `streaming`; a message has a `stream`. Here they read the same.
            let entries = transcript["entries"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            Ok(Value::Array(
                entries
                    .into_iter()
                    .map(|mut entry| {
                        if let Some(state) = entry.get("streaming").cloned() {
                            entry["stream"] = serde_json::json!({ "state": state });
                        }
                        entry
                    })
                    .collect(),
            ))
        })
    }
}

/// A transcript that takes the viewer (`as`, Slack's); only when it is given, as in matchers-core.
macro_rules! transcript_as {
    ($($handle:ty),+) => {$(
        impl Readable for $handle {
            fn read_transcript(&self, viewer: Value) -> BoxFuture<'_, Result<Value>> {
                let read = self.transcript();
                Box::pin(if viewer.is_null() { read } else { read.r#as(viewer) }.into_future())
            }
        }
    )+};
}

macro_rules! transcript {
    ($($handle:ty),+) => {$(
        impl Readable for $handle {
            fn read_transcript(&self, _viewer: Value) -> BoxFuture<'_, Result<Value>> {
                Box::pin(self.transcript().into_future())
            }
        }
    )+};
}

/// A transcript's entries.
async fn entries(transcript: impl IntoFuture<Output = Result<Value>>) -> Result<Value> {
    Ok(transcript.await?["entries"].take())
}

impl Buttons for SlackMessage {
    /// A message is one entry of its thread's transcript.
    fn read_entries(&self) -> BoxFuture<'_, Result<Value>> {
        Box::pin(entries(self.thread().transcript()))
    }
    fn entry_id(&self) -> Option<String> {
        Some(self.ts())
    }
}

macro_rules! latest_buttons {
    ($($handle:ty),+) => {$(
        impl Buttons for $handle {
            fn read_entries(&self) -> BoxFuture<'_, Result<Value>> {
                Box::pin(entries(self.transcript()))
            }
            fn entry_id(&self) -> Option<String> {
                None
            }
        }
    )+};
}
latest_buttons!(SlackThread, SlackConversation);

impl Ephemeral for SlackMessage {
    fn visible_to(&self) -> Value {
        self.data().get("visibleTo").cloned().unwrap_or(Value::Null)
    }
}

impl PullRequest for GitHubPullRequest {
    fn read_review_comments(&self) -> BoxFuture<'_, Result<Value>> {
        Box::pin(self.review_comments().into_future())
    }
    fn read_reviews(&self) -> BoxFuture<'_, Result<Value>> {
        Box::pin(self.reviews().into_future())
    }
    fn read_merged(&self) -> BoxFuture<'_, Result<Value>> {
        Box::pin(self.merged().into_future())
    }
}

impl AgentSession for LinearAgentSession {
    fn read_session_state(&self) -> BoxFuture<'_, Result<Value>> {
        Box::pin(self.state().into_future())
    }
    fn read_activities(&self) -> BoxFuture<'_, Result<Value>> {
        Box::pin(self.activities().into_future())
    }
}

impl LinearIssue {
    /// The issue's latest agent session, if it has one.
    async fn latest_session(&self) -> Result<Option<LinearAgentSession>> {
        let sessions = self.sessions().await?;
        Ok(LinearAgentSession::wrap_vec(self.ctx(), sessions)?.pop())
    }
}

impl AgentSession for LinearIssue {
    fn read_session_state(&self) -> BoxFuture<'_, Result<Value>> {
        Box::pin(async {
            match self.latest_session().await? {
                Some(session) => session.state().await,
                None => Ok(Value::from("no session")),
            }
        })
    }
    fn read_activities(&self) -> BoxFuture<'_, Result<Value>> {
        Box::pin(async {
            match self.latest_session().await? {
                Some(session) => session.activities().await,
                None => Ok(Value::Array(vec![])),
            }
        })
    }
}

impl Issue for LinearIssue {
    fn read_delegate(&self) -> BoxFuture<'_, Result<Value>> {
        Box::pin(async { Ok(self.delegated_to().await?.as_ref().into_arg()) })
    }
    fn read_assignee(&self) -> BoxFuture<'_, Result<Value>> {
        Box::pin(async { Ok(self.assignee().await?.as_ref().into_arg()) })
    }
    fn read_workflow_state(&self) -> BoxFuture<'_, Result<Value>> {
        Box::pin(self.state().into_future())
    }
}

impl Page for NotionPage {
    fn read_blocks(&self) -> BoxFuture<'_, Result<Value>> {
        Box::pin(self.blocks().into_future())
    }
    fn read_property(&self, name: &str) -> BoxFuture<'_, Result<Value>> {
        Box::pin(self.property(name).into_future())
    }
}

macro_rules! deliveries {
    ($($handle:ty),+) => {$(
        impl Delivery for $handle {
            fn delivery_id(&self) -> String {
                self.id()
            }
            fn read_attempts(&self) -> BoxFuture<'_, Result<Value>> {
                Box::pin(async { Ok(self.refresh().await?.attempts().clone()) })
            }
        }
    )+};
}

macro_rules! calls {
    ($($handle:ty),+) => {$(
        impl Calls for $handle {
            fn read_calls(&self, error: Value) -> BoxFuture<'_, Result<Value>> {
                let read = self.calls();
                Box::pin(if error.is_null() { read } else { read.error(error) }.into_future())
            }
        }
    )+};
}

// Which handles have the reads every channel has the same way (a transcript, deliveries, calls),
// generated with the SDK from the IR, so a new channel's handles are subjects without listing them here.
include!("../generated/subjects.rs");
