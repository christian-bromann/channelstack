//! Find or start the server: `Auto` attaches if one is running and starts one otherwise.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use tokio::process::{Child, Command};

use super::error::{Error, Result};

const STATUS_PATH: &str = "/_channelstack/status";

/// How the client finds its server.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Mode {
    /// Attach to a running server, or start one.
    #[default]
    Auto,
    /// Attach to a running server; fail without one.
    Attach,
    /// Always start a private server, stopped when the client closes.
    Start,
}

/// A server to talk to, and the process this launcher started for it, if it started one.
pub struct ServerConnection {
    pub url: String,
    pub token: String,
    pub(crate) started: Option<Started>,
}

/// A server this launcher started: stopped, and its directory removed, when the client closes.
pub(crate) struct Started {
    child: Child,
    directory: PathBuf,
}

impl Started {
    pub(crate) async fn stop(mut self) {
        let _ = self.child.kill().await;
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn read_server_file(path: &Path) -> Option<(String, String)> {
    let data: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let url = data.get("url")?.as_str()?.trim_end_matches('/').to_owned();
    let token = data.get("token")?.as_str()?.to_owned();
    Some((url, token))
}

async fn is_up(url: &str, token: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    matches!(client.get(format!("{url}{STATUS_PATH}")).bearer_auth(token).send().await, Ok(response) if response.status().is_success())
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn home() -> PathBuf {
    env("CHANNELSTACK_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env("HOME").unwrap_or_else(|| ".".into())).join(".channelstack")
        })
}

/// The running server to attach to: an explicit URL, or the one in `server.json`.
fn attach_target(server: Option<&str>, token: Option<&str>) -> Option<(String, String)> {
    let from_file = read_server_file(&home().join("server.json"));
    let url = server
        .map(str::to_owned)
        .or_else(|| env("CHANNELSTACK_URL"))
        .map(|url| url.trim_end_matches('/').to_owned());
    match url {
        None => from_file,
        Some(url) => {
            let found = token
                .map(str::to_owned)
                .or_else(|| env("CHANNELSTACK_TOKEN"))
                .or_else(|| {
                    from_file
                        .filter(|(file_url, _)| *file_url == url)
                        .map(|(_, token)| token)
                })?;
            Some((url, found))
        }
    }
}

/// The server binary: `CHANNELSTACK_SERVER_BIN`, or `channelstack` on the PATH.
fn server_binary() -> Result<String> {
    if let Some(binary) = env("CHANNELSTACK_SERVER_BIN") {
        return Ok(binary);
    }
    let path = env("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .map(|dir| dir.join("channelstack"))
        .find(|candidate| candidate.is_file())
        .map(|found| found.to_string_lossy().into_owned())
        .ok_or_else(|| Error::Launch("No channelstack server binary found. Set CHANNELSTACK_SERVER_BIN, or install channelstack.".into()))
}

/// Start a private server on a free loopback port. Its token goes to a private file, never to the shared one.
async fn start_server() -> Result<ServerConnection> {
    let directory = std::env::temp_dir().join(format!(
        "channelstack-{}-{}",
        std::process::id(),
        rand_suffix()
    ));
    std::fs::create_dir_all(&directory).map_err(|error| Error::Launch(error.to_string()))?;
    let server_file = directory.join("server.json");
    let mut child = Command::new(server_binary()?)
        .args(["start", "--no-portless", "--port", "0", "--server-file"])
        .arg(&server_file)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            Error::Launch(format!("Couldn't start the channelstack server: {error}"))
        })?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            let _ = std::fs::remove_dir_all(&directory);
            return Err(Error::Launch(format!(
                "The channelstack server exited before it was ready ({status})"
            )));
        }
        if let Some((url, token)) = read_server_file(&server_file)
            && is_up(&url, &token).await
        {
            return Ok(ServerConnection {
                url,
                token,
                started: Some(Started { child, directory }),
            });
        }
        if tokio::time::Instant::now() > deadline {
            Started { child, directory }.stop().await;
            return Err(Error::Launch(
                "The channelstack server didn't start within 15s".into(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A name for a private directory that two clients started at once don't share.
fn rand_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.subsec_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

pub async fn launch(
    mode: Mode,
    server: Option<&str>,
    token: Option<&str>,
) -> Result<ServerConnection> {
    if mode != Mode::Start {
        let target = attach_target(server, token);
        if let Some((url, token)) = &target
            && is_up(url, token).await
        {
            return Ok(ServerConnection {
                url: url.clone(),
                token: token.clone(),
                started: None,
            });
        }
        if mode == Mode::Attach {
            let wheres = match &target {
                Some((url, _)) => format!("No channelstack server is answering at {url}."),
                None => "No running channelstack server found.".into(),
            };
            return Err(Error::Launch(format!(
                "{wheres} Start one with `npx channelstack`."
            )));
        }
    }
    start_server().await
}
