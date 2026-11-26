//! What can go wrong: the control API refusing (with its stable error code), or the way to it.

use serde_json::Value;

/// An error from the SDK. A refusal of the control API is `Api`, with the protocol's code.
#[derive(thiserror::Error)]
pub enum Error {
    /// The control API refused: `code` is the stable error code (`not_in_channel`, `session_not_found`).
    #[error("{code}: {message}")]
    Api {
        code: String,
        status: u16,
        message: String,
        data: Value,
    },
    /// The server couldn't be reached, or answered with something that isn't the control API.
    #[error("{0}")]
    Http(#[from] reqwest::Error),
    /// Starting or finding the server failed.
    #[error("{0}")]
    Launch(String),
    /// A wait ran out of time.
    #[error("Timed out after {timeout_ms}ms waiting for {what}")]
    Timeout { what: String, timeout_ms: f64 },
    /// An argument the SDK can't send: a duration that isn't one, a handle where text is expected.
    #[error("{0}")]
    Invalid(String),
    /// A fixture file or directory a test handed over couldn't be read: not there, or not a directory.
    #[error("{path}: {source}")]
    Files {
        path: String,
        source: std::io::Error,
    },
    /// A check of `expect(…)` failed: what was expected, and what was there instead.
    #[error("{0}")]
    Expectation(String),
}

/// A pattern Rust's regex refuses, so `Regex::new(…)?` works in a test that returns `Result`.
impl From<regex::Error> for Error {
    fn from(error: regex::Error) -> Self {
        Error::Invalid(error.to_string())
    }
}

/// As derived, except that a failed check prints its message as it is: a test that returns
/// `Result` prints its error with `{:?}`, and the message has lines of its own.
impl std::fmt::Debug for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Api {
                code,
                status,
                message,
                data,
            } => f
                .debug_struct("Api")
                .field("code", code)
                .field("status", status)
                .field("message", message)
                .field("data", data)
                .finish(),
            Error::Http(error) => f.debug_tuple("Http").field(error).finish(),
            Error::Launch(message) => f.debug_tuple("Launch").field(message).finish(),
            Error::Timeout { what, timeout_ms } => f
                .debug_struct("Timeout")
                .field("what", what)
                .field("timeout_ms", timeout_ms)
                .finish(),
            Error::Invalid(message) => f.debug_tuple("Invalid").field(message).finish(),
            Error::Files { path, source } => f
                .debug_struct("Files")
                .field("path", path)
                .field("source", source)
                .finish(),
            Error::Expectation(message) => f.write_str(message),
        }
    }
}

impl Error {
    /// The protocol's error code, for a refusal of the control API.
    pub fn code(&self) -> Option<&str> {
        match self {
            Error::Api { code, .. } => Some(code),
            _ => None,
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
