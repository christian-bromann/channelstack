//! What can go wrong: the control API refusing (with its stable error code), or the way to it.

use serde_json::Value;

/// An error from the SDK. A refusal of the control API is `Api`, with the protocol's code.
#[derive(Debug, thiserror::Error)]
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
