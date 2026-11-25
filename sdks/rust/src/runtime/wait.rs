//! The one polling loop. Every `wait_for_…`, `latest_…` and matcher is built on it; tests never sleep.

use std::future::Future;
use std::time::Duration;

use serde_json::Value;

use super::duration::parse_duration;
use super::error::{Error, Result};

/// Read until `read` answers `Some`, or the timeout passes.
pub async fn wait_for<T, F, Fut>(what: &str, timeout: &Value, mut read: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Option<T>>>,
{
    let timeout_ms = parse_duration(timeout)?;
    let interval = Duration::from_millis(50);
    let deadline = tokio::time::Instant::now() + Duration::from_secs_f64(timeout_ms / 1000.0);
    loop {
        if let Some(value) = read().await? {
            return Ok(value);
        }
        if tokio::time::Instant::now() + interval > deadline {
            return Err(Error::Timeout {
                what: what.to_owned(),
                timeout_ms,
            });
        }
        tokio::time::sleep(interval).await;
    }
}

/// Repeat a call while it is refused with one of these codes, the way a person waits for a button
/// to appear before clicking it. When the time is up, the last refusal is the error.
pub async fn retry_while<F, Fut>(codes: &[&str], mut call: F) -> Result<Value>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Value>>,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match call().await {
            Err(error)
                if error.code().is_some_and(|code| codes.contains(&code))
                    && tokio::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            other => return other,
        }
    }
}

/// Does a text match: a string it contains, a pattern (`{ "source": … }`), or nothing (any text)?
pub fn text_matches(text: &str, expected: &Value) -> bool {
    match expected {
        Value::Null => true,
        Value::String(wanted) => text.contains(wanted.as_str()),
        // A pattern is matched by the server's own reads; on the client, its source as plain text.
        Value::Object(pattern) => pattern
            .get("source")
            .and_then(Value::as_str)
            .is_some_and(|source| text.contains(source)),
        _ => false,
    }
}

/// Does an author match a `from` filter: a handle's data (by id), a name or id, or nothing (anyone)?
pub fn from_matches(author: &Value, from: &Value) -> bool {
    let field =
        |value: &Value, name: &str| value.get(name).and_then(Value::as_str).map(str::to_owned);
    match from {
        Value::Null => true,
        Value::String(wanted) => {
            field(author, "name").as_deref() == Some(wanted)
                || field(author, "id").as_deref() == Some(wanted)
        }
        other => field(other, "id").is_some() && field(author, "id") == field(other, "id"),
    }
}

/// The state of the agent in a session, as `GET /sessions/{session}/quiet` answers it.
pub struct QuietState {
    pub busy: bool,
    pub quiet_for_ms: f64,
    pub open: Vec<String>,
}

impl QuietState {
    pub fn from_wire(state: &Value) -> Self {
        Self {
            busy: state.get("busy").and_then(Value::as_bool).unwrap_or(false),
            quiet_for_ms: state
                .get("quietForMs")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            open: state
                .get("open")
                .and_then(Value::as_array)
                .map(|open| {
                    open.iter()
                        .filter_map(|item| item.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
}

/// Resolve once the agent has been quiet for `quiet_for`.
pub async fn until_quiet<F, Fut>(quiet: F, timeout: &Value, quiet_for: &Value) -> Result<()>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<QuietState>>,
{
    let quiet_for_ms = parse_duration(quiet_for)?;
    wait_for(
        &format!("the agent to be quiet for {quiet_for_ms}ms"),
        timeout,
        || {
            let state = quiet();
            async move {
                let state = state.await?;
                Ok((!state.busy && state.quiet_for_ms >= quiet_for_ms).then_some(()))
            }
        },
    )
    .await
}

/// The first new item of a list that matches, after the last one this handle returned.
/// `seen` is how far the handle has looked; with `starts_turn`, only after the newest turn.
pub async fn wait_for_next<F, Fut>(
    seen: &std::sync::Mutex<std::collections::HashMap<String, usize>>,
    key: &str,
    read: F,
    matches: impl Fn(&Value) -> bool,
    starts_turn: Option<&(dyn Fn(&Value) -> bool + Sync)>,
    what: &str,
    timeout: &Value,
) -> Result<Value>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<Value>>,
{
    wait_for(what, timeout, || {
        let items = read();
        let matches = &matches;
        async move {
            let items = items.await?;
            let items = items.as_array().cloned().unwrap_or_default();
            let turn = starts_turn
                .and_then(|starts| items.iter().rposition(starts).map(|position| position + 1))
                .unwrap_or(0);
            let mut seen = seen.lock().expect("a handle's wait state");
            let from = (*seen.get(key).unwrap_or(&0)).max(turn);
            for (position, item) in items.iter().enumerate().skip(from) {
                if matches(item) {
                    seen.insert(key.to_owned(), position + 1);
                    return Ok(Some(item.clone()));
                }
            }
            Ok(None)
        }
    })
    .await
}

/// The latest matching item of a list, once the agent is quiet. Waits for at least one.
pub async fn latest_once_quiet<F, Fut, Q, QFut>(
    read: F,
    matches: impl Fn(&Value) -> bool,
    quiet: Q,
    what: &str,
    timeout: &Value,
    quiet_for: &Value,
) -> Result<Value>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<Value>>,
    Q: Fn() -> QFut,
    QFut: Future<Output = Result<QuietState>>,
{
    until_quiet(quiet, timeout, quiet_for).await?;
    wait_for(what, timeout, || {
        let items = read();
        let matches = &matches;
        async move {
            let items = items.await?;
            Ok(items
                .as_array()
                .and_then(|items| items.iter().rev().find(|item| matches(item)).cloned()))
        }
    })
    .await
}
