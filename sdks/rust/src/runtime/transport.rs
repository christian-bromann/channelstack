//! The HTTP client every generated method goes through: bearer token, retries while the server
//! starts, and the control API's refusals as `Error::Api`.

use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use super::error::{Error, Result};

/// How long a connection that is refused is retried, while the server starts.
const CONNECT_RETRY: Duration = Duration::from_secs(5);
const CONNECT_RETRY_INTERVAL: Duration = Duration::from_millis(100);

pub struct Transport {
    client: reqwest::Client,
    url: String,
    token: String,
    base_path: String,
}

/// Leave out what is `null`: an option nobody gave isn't sent.
fn without_null(values: Map<String, Value>) -> Map<String, Value> {
    values
        .into_iter()
        .filter(|(_, value)| !value.is_null())
        .collect()
}

impl Transport {
    pub fn new(url: &str, token: &str, base_path: &str) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(Self {
            client,
            url: url.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            base_path: base_path.to_owned(),
        })
    }

    /// Send a request to the control API; answer its JSON, or the refusal as `Error::Api`.
    pub async fn request(
        &self,
        verb: &str,
        path: &str,
        body: Option<Map<String, Value>>,
        query: Option<Map<String, Value>>,
    ) -> Result<Value> {
        let url = format!("{}{}{}", self.url, self.base_path, path);
        let method = reqwest::Method::from_bytes(verb.as_bytes())
            .map_err(|_| Error::Invalid(format!("Not a method: {verb}")))?;
        let query: Vec<(String, String)> = without_null(query.unwrap_or_default())
            .into_iter()
            .map(|(name, value)| {
                (
                    name,
                    value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string()),
                )
            })
            .collect();
        let body = body.map(without_null);
        let deadline = Instant::now() + CONNECT_RETRY;
        let response = loop {
            let mut request = self
                .client
                .request(method.clone(), &url)
                .bearer_auth(&self.token)
                .query(&query);
            if let Some(body) = &body {
                request = request.json(body);
            }
            match request.send().await {
                Ok(response) => break response,
                // Nothing was sent, so retrying is safe.
                Err(error) if error.is_connect() && Instant::now() < deadline => {
                    tokio::time::sleep(CONNECT_RETRY_INTERVAL).await;
                }
                Err(error) => return Err(error.into()),
            }
        };
        let status = response.status();
        let text = response.text().await?;
        let payload: Value = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).map_err(|_| Error::Api {
                code: "internal".into(),
                status: status.as_u16(),
                message: format!("HTTP {}: the response is not JSON", status.as_u16()),
                data: Value::Null,
            })?
        };
        if status.is_success() {
            return Ok(payload);
        }
        Err(Error::Api {
            code: payload
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("internal")
                .to_owned(),
            status: status.as_u16(),
            message: payload
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("HTTP {}", status.as_u16())),
            data: payload.get("data").cloned().unwrap_or(Value::Null),
        })
    }
}
