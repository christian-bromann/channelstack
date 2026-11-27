//! Answering model calls from the test (decision 0029): the server holds each call a responder
//! script matches, and this task reads them (a long poll), runs the test's function and posts what
//! it returns. It runs until the script is undone or its session closes, which end its reads.

use std::future::Future;
use std::sync::Arc;

use serde_json::Value;

use super::client::{BoxFuture, IntoArg};
use super::error::Result;

/// How long one read waits on the server for a held call: well inside any HTTP timeout.
const LONG_POLL_MS: u64 = 20_000;

/// The long-poll read of a responder's handle: the calls held since a cursor, waiting up to so long.
pub type Held = Box<dyn Fn(Option<String>, u64) -> BoxFuture<'static, Result<Value>> + Send + Sync>;
/// The way to answer one held call: with a turn, or with why the test's function failed.
pub type Answer = Arc<
    dyn Fn(String, Option<Value>, Option<String>) -> BoxFuture<'static, Result<()>> + Send + Sync,
>;

/// Start answering a responder script's calls in the background, on the running Tokio runtime.
pub fn respond_with<F, Fut, T>(held: Held, answer: Answer, respond: F)
where
    F: Fn(Value) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = T> + Send + 'static,
    T: IntoArg + Send + 'static,
{
    let respond = Arc::new(respond);
    tokio::spawn(async move {
        let mut since: Option<String> = None;
        loop {
            // The script was undone, or its session closed: nothing more will be held for it.
            let Ok(page) = held(since.clone(), LONG_POLL_MS).await else {
                return;
            };
            since = page
                .get("cursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let calls = page
                .get("held")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for call in calls {
                let id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let request = call.get("request").cloned().unwrap_or(Value::Null);
                let respond = Arc::clone(&respond);
                let answer = Arc::clone(&answer);
                // Each call is answered on its own, so a slow answer doesn't hold up the next call.
                tokio::spawn(async move {
                    // A function that panics is the test's bug: the server is told why, and the test fails with it.
                    let outcome =
                        tokio::spawn(async move { respond(request).await.into_arg() }).await;
                    let (turn, error) = match outcome {
                        Ok(turn) => (Some(turn), None),
                        Err(panicked) => {
                            (None, Some(format!("the responder panicked: {panicked}")))
                        }
                    };
                    // The agent hung up, or the call was answered by its timeout: the server has recorded why.
                    let _ = answer(id, turn, error).await;
                });
            }
        }
    });
}
