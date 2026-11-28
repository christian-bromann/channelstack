//! The one polling loop. Every `wait_for_…`, `latest_…` and matcher is built on it; tests never sleep.

use std::future::Future;
use std::time::Duration;

use serde_json::Value;

use super::duration::parse_duration;
use super::error::{Error, Result};

/// How long a wait gives up after when it isn't given a `timeout`: the one place this default lives.
/// No test framework integration sets it in Rust, so it isn't settable here.
pub const DEFAULT_TIMEOUT: &str = "10s";
/// How long the agent must be quiet when a wait isn't given a `quietFor`.
pub const DEFAULT_QUIET_FOR: &str = "750ms";

/// Read until `read` answers `Some`, or the timeout passes.
pub async fn wait_for<T, F, Fut>(what: &str, timeout: &Value, mut read: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Option<T>>>,
{
    let timeout_ms = parse_duration(timeout)?;
    let interval = Duration::from_millis(50);
    let deadline = Duration::try_from_secs_f64(timeout_ms / 1000.0)
        .ok()
        .and_then(|timeout| tokio::time::Instant::now().checked_add(timeout))
        .ok_or_else(|| Error::Invalid(format!("Not a usable timeout: {timeout_ms}ms")))?;
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
    let refusal = std::sync::Mutex::new(None::<Error>);
    let accepted = wait_for(
        "the call to be accepted",
        &Value::from(DEFAULT_TIMEOUT),
        || {
            let attempt = call();
            let refusal = &refusal;
            async move {
                match attempt.await {
                    Ok(value) => Ok(Some(value)),
                    Err(error) if error.code().is_some_and(|code| codes.contains(&code)) => {
                        *refusal.lock().expect("the last refusal") = Some(error);
                        Ok(None)
                    }
                    Err(error) => Err(error),
                }
            }
        },
    )
    .await;
    match accepted {
        Err(Error::Timeout { .. }) => match refusal.lock().expect("the last refusal").take() {
            Some(refused) => Err(refused),
            None => accepted,
        },
        other => other,
    }
}

/// Does a text match: a string it contains, a pattern (`{ "source": … }`), or nothing (any text)?
pub fn text_matches(text: &str, expected: &Value) -> bool {
    match expected {
        Value::Null => true,
        Value::String(wanted) => text.contains(wanted.as_str()),
        // A pattern that doesn't compile never matches; `check_text` refuses it before a wait starts.
        Value::Object(pattern) => pattern_regex(pattern).is_ok_and(|regex| regex.is_match(text)),
        _ => false,
    }
}

/// A `Regex` as it goes on the wire (`{ "source": …, "flags": "im" }`), as Python's `pattern_on_wire`
/// sends one: the server's patterns are JavaScript's, which have no inline flags, so a leading flag
/// group (`(?i)`, `(?ms)`) moves into `flags`. Any other group stays in the source.
pub fn pattern_on_wire(regex: &regex::Regex) -> Value {
    let mut source = regex.as_str();
    let mut inline = String::new();
    while let Some((group, rest)) = source
        .strip_prefix("(?")
        .and_then(|after| after.split_once(')'))
        .filter(|(group, _)| !group.is_empty() && group.chars().all(|flag| "ims".contains(flag)))
    {
        inline.push_str(group);
        source = rest;
    }
    let flags: String = "ims"
        .chars()
        .filter(|flag| inline.contains(*flag))
        .collect();
    serde_json::json!({ "source": source, "flags": flags })
}

/// A pattern as it goes on the wire (`{ "source": …, "flags": "im" }`) as a regular expression.
/// The flags the SDKs send are `i`, `m` and `s`, which mean the same in Rust's regex syntax.
fn pattern_regex(pattern: &serde_json::Map<String, Value>) -> Result<regex::Regex> {
    let source = pattern
        .get("source")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Invalid("A pattern needs its `source`".into()))?;
    let flags: String = pattern
        .get("flags")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .filter(|flag| matches!(flag, 'i' | 'm' | 's'))
        .collect();
    let prefix = if flags.is_empty() {
        String::new()
    } else {
        format!("(?{flags})")
    };
    regex::Regex::new(&format!("{prefix}{source}")).map_err(|error| {
        Error::Invalid(format!(
            "The pattern /{source}/ isn't one Rust's regex can use: {error}"
        ))
    })
}

/// Refuse text to look for that can never match: a pattern Rust's regex can't compile (look-around,
/// back-references). Waits call it before they start, so the error says why instead of timing out.
pub fn check_text(expected: &Value) -> Result<()> {
    match expected {
        Value::Object(pattern) => pattern_regex(pattern).map(|_| ()),
        _ => Ok(()),
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
    /// The bot loops the fake stopped in the session (decision 0027), in words.
    pub loops: Vec<String>,
}

impl QuietState {
    pub fn from_wire(state: &Value) -> Self {
        Self {
            busy: state.get("busy").and_then(Value::as_bool).unwrap_or(false),
            quiet_for_ms: state
                .get("quietForMs")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            open: words(state, "open"),
            loops: words(state, "loops"),
        }
    }
}

/// A list of words the server answered under `key`, or none.
fn words(state: &Value, key: &str) -> Vec<String> {
    state
        .get(key)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Resolve once the agent has been quiet for `quiet_for`. A wait that gives up says what the agent
/// left open: that is usually the bug.
///
/// With `watching`, the quiet time counts from now at the earliest: the caller wants to have looked
/// for the whole window. An agent that is thinking makes no sound, so a session that went quiet a
/// while ago says nothing about what arrives next.
pub async fn until_quiet<F, Fut>(
    quiet: F,
    timeout: &Value,
    quiet_for: &Value,
    watching: bool,
) -> Result<()>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<QuietState>>,
{
    let quiet_for_ms = parse_duration(quiet_for)?;
    let started = tokio::time::Instant::now();
    let still_open = std::sync::Mutex::new(Vec::<String>::new());
    let settled = wait_for(
        &format!("the agent to be quiet for {quiet_for_ms}ms"),
        timeout,
        || {
            let state = quiet();
            let still_open = &still_open;
            async move {
                let state = state.await?;
                *still_open.lock().expect("what is still open") = state.open.clone();
                if watching && started.elapsed().as_secs_f64() * 1000.0 < quiet_for_ms {
                    return Ok(None);
                }
                Ok((!state.busy && state.quiet_for_ms >= quiet_for_ms).then_some(()))
            }
        },
    )
    .await;
    match settled {
        Err(Error::Timeout { what, timeout_ms }) => {
            let open = still_open.lock().expect("what is still open").join("; ");
            Err(Error::Timeout {
                what: if open.is_empty() {
                    what
                } else {
                    format!("{what}. Still open: {open}")
                },
                timeout_ms,
            })
        }
        other => other,
    }
}

/// How far each `wait_for_…` of a handle has looked, so the next one waits for something new; and
/// the same for the handles in its fields, so `msg.thread()` is the same thread every time.
#[derive(Default)]
pub struct WaitState {
    pub positions: std::sync::Mutex<std::collections::HashMap<String, usize>>,
    fields: std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<WaitState>>>,
}

impl WaitState {
    /// The state of the handle in this field (`thread`, or `items.0` for an array's first).
    pub fn field(&self, key: &str) -> std::sync::Arc<WaitState> {
        self.fields
            .lock()
            .expect("a handle's wait state")
            .entry(key.to_owned())
            .or_default()
            .clone()
    }
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
    let latest = || {
        let items = read();
        let matches = &matches;
        async move {
            let items = items.await?;
            Ok(items
                .as_array()
                .and_then(|items| items.iter().rev().find(|item| matches(item)).cloned()))
        }
    };
    wait_for(what, timeout, latest).await?;
    until_quiet(quiet, timeout, quiet_for, false).await?;
    // The agent may have said more while it was settling: the answer is what is there now.
    wait_for(what, timeout, latest).await
}

#[cfg(test)]
mod tests {
    use super::{check_text, pattern_on_wire, text_matches};
    use serde_json::json;

    #[test]
    fn a_regex_goes_on_the_wire_with_its_inline_flags_as_flags() {
        let wire = |source: &str| pattern_on_wire(&regex::Regex::new(source).unwrap());
        assert_eq!(
            wire("(?i)rate limits"),
            json!({ "source": "rate limits", "flags": "i" })
        );
        assert_eq!(
            wire("(?s)(?mi)^a.b"),
            json!({ "source": "^a.b", "flags": "ims" })
        );
        assert_eq!(
            wire("ENG-\\d+"),
            json!({ "source": "ENG-\\d+", "flags": "" })
        );
        // A scoped group, or a flag JavaScript has no equivalent for, stays where it is.
        assert_eq!(wire("(?i:a)b"), json!({ "source": "(?i:a)b", "flags": "" }));
        assert_eq!(wire("(?x)a b"), json!({ "source": "(?x)a b", "flags": "" }));
        // And it matches what the Regex matched.
        assert!(text_matches("RATE LIMITS", &wire("(?i)rate limits")));
    }

    #[test]
    fn texts_and_patterns() {
        assert!(text_matches("Deploying web", &json!(null)));
        assert!(text_matches("Deploying web", &json!("web")));
        assert!(!text_matches("Deploying web", &json!("API")));
        assert!(text_matches(
            "ENG-42 filed",
            &json!({ "source": "ENG-\\d+", "flags": "" })
        ));
        assert!(!text_matches(
            "ENG-x filed",
            &json!({ "source": "ENG-\\d+", "flags": "" })
        ));
        assert!(text_matches(
            "INCIDENT report",
            &json!({ "source": "incident", "flags": "i" })
        ));
        assert!(!text_matches(
            "INCIDENT report",
            &json!({ "source": "incident", "flags": "" })
        ));
        assert!(text_matches(
            "a\nb",
            &json!({ "source": "^b$", "flags": "m" })
        ));
        // A pattern Rust's regex can't use is refused up front, with the reason.
        let lookahead = json!({ "source": "a(?=b)", "flags": "" });
        assert!(!text_matches("ab", &lookahead));
        let refused = check_text(&lookahead).unwrap_err().to_string();
        assert!(
            refused.contains("/a(?=b)/ isn't one Rust's regex can use"),
            "{refused}"
        );
        assert!(check_text(&json!("plain text")).is_ok());
    }

    fn refusal(code: &str) -> super::Error {
        super::Error::Api {
            code: code.into(),
            status: 409,
            message: code.into(),
            data: json!({}),
        }
    }

    #[tokio::test]
    async fn retry_while_repeats_only_the_refusals_it_names() {
        let attempts = std::sync::atomic::AtomicUsize::new(0);
        let accepted = super::retry_while(&["not_yet"], || {
            let attempt = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move {
                if attempt < 2 {
                    Err(refusal("not_yet"))
                } else {
                    Ok(json!("clicked"))
                }
            }
        })
        .await;
        assert_eq!(accepted.unwrap(), json!("clicked"));
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 3);

        // Any other refusal is the answer at once.
        let refused =
            super::retry_while(&["not_yet"], || async { Err(refusal("not_allowed")) }).await;
        assert_eq!(refused.unwrap_err().code(), Some("not_allowed"));
    }

    #[tokio::test]
    async fn a_quiet_wait_that_gives_up_says_what_is_still_open() {
        let busy = || async {
            Ok(super::QuietState {
                busy: true,
                quiet_for_ms: 0.0,
                open: vec!["a stream my-agent never stopped".into()],
                loops: vec![],
            })
        };
        let gave_up = super::until_quiet(busy, &json!("120ms"), &json!("50ms"), false)
            .await
            .unwrap_err()
            .to_string();
        assert!(
            gave_up.contains("Still open: a stream my-agent never stopped"),
            "{gave_up}"
        );
    }

    #[tokio::test]
    async fn a_watching_wait_for_quiet_looks_for_the_whole_window() {
        let long_quiet = || async {
            Ok(super::QuietState {
                busy: false,
                quiet_for_ms: 60_000.0,
                open: vec![],
                loops: vec![],
            })
        };
        let started = std::time::Instant::now();
        super::until_quiet(long_quiet, &json!("1s"), &json!("80ms"), false)
            .await
            .unwrap();
        assert!(started.elapsed() < std::time::Duration::from_millis(60));

        let started = std::time::Instant::now();
        super::until_quiet(long_quiet, &json!("1s"), &json!("80ms"), true)
            .await
            .unwrap();
        assert!(started.elapsed() >= std::time::Duration::from_millis(80));
    }
}
