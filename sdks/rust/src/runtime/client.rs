//! What generated handles share: their context, how arguments go on the wire, and the one
//! function every method sends its request through.

use std::future::{Future, IntoFuture};
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::{Map, Value};

use super::credentials::credential;
use super::duration::parse_duration;
use super::error::{Error, Result};
use super::launcher::Started;
use super::transport::Transport;
use super::wait::{DEFAULT_QUIET_FOR, DEFAULT_TIMEOUT, QuietState, retry_while, until_quiet};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What a handle needs to call the server: the transport, and the session it lives in.
#[derive(Clone)]
pub struct Ctx {
    pub(crate) transport: Arc<Transport>,
    pub(crate) session: Option<String>,
    /// A server this client started: stopped when the root client closes.
    pub(crate) started: Arc<Mutex<Option<Started>>>,
}

impl Ctx {
    /// The session a handle lives in. Only the root client has none.
    pub fn session(&self) -> Result<&str> {
        self.session
            .as_deref()
            .ok_or_else(|| Error::Invalid("This handle doesn't belong to a session".into()))
    }

    /// The same server, in another session: what a session handle's children live in.
    pub fn in_session(&self, session: Option<String>) -> Ctx {
        Ctx {
            transport: self.transport.clone(),
            session,
            started: self.started.clone(),
        }
    }

    /// Ask the server whether the agent is quiet in this handle's session.
    pub async fn quiet(&self) -> Result<QuietState> {
        let session = encode_segment(self.session()?);
        let state = self
            .transport
            .request("GET", &format!("/sessions/{session}/quiet"), None, None)
            .await?;
        Ok(QuietState::from_wire(&state))
    }
}

/// A handle: an object with an identity on the server. Its data is what the server answered.
pub trait Handle {
    fn data(&self) -> &Value;
    fn ctx(&self) -> &Ctx;
}

/// A value an SDK method takes: text, a number, a flag, JSON, a list, or a handle (sent by its id).
pub trait IntoArg {
    fn into_arg(self) -> Value;
}

impl IntoArg for Value {
    fn into_arg(self) -> Value {
        self
    }
}
impl IntoArg for &Value {
    fn into_arg(self) -> Value {
        self.clone()
    }
}
impl IntoArg for &str {
    fn into_arg(self) -> Value {
        Value::String(self.to_owned())
    }
}
impl IntoArg for String {
    fn into_arg(self) -> Value {
        Value::String(self)
    }
}
impl IntoArg for &String {
    fn into_arg(self) -> Value {
        Value::String(self.clone())
    }
}
impl IntoArg for bool {
    fn into_arg(self) -> Value {
        Value::Bool(self)
    }
}
macro_rules! numbers {
    ($($type:ty),*) => {$(impl IntoArg for $type {
        fn into_arg(self) -> Value {
            serde_json::json!(self)
        }
    })*};
}
numbers!(u8, i32, i64, u32, u64, usize, f64);
impl<T: IntoArg> IntoArg for Vec<T> {
    fn into_arg(self) -> Value {
        Value::Array(self.into_iter().map(IntoArg::into_arg).collect())
    }
}
impl<T: IntoArg> IntoArg for Option<T> {
    fn into_arg(self) -> Value {
        self.map_or(Value::Null, IntoArg::into_arg)
    }
}
/// A pattern, as it goes on the wire (`{ "source": …, "flags": … }`): see `pattern_on_wire`.
impl IntoArg for &regex::Regex {
    fn into_arg(self) -> Value {
        crate::runtime::wait::pattern_on_wire(self)
    }
}
impl IntoArg for regex::Regex {
    fn into_arg(self) -> Value {
        (&self).into_arg()
    }
}
impl<H: Handle + ?Sized> IntoArg for &H {
    fn into_arg(self) -> Value {
        self.data().clone()
    }
}

/// Everything but letters and digits is escaped in a path segment.
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

pub fn encode_segment(value: &str) -> String {
    utf8_percent_encode(value, SEGMENT).to_string()
}

/// A path parameter of a request: text from the session, or a field of the handle.
pub fn path_value(value: &Value) -> Result<String> {
    match value {
        Value::String(text) => Ok(encode_segment(text)),
        Value::Number(number) => Ok(number.to_string()),
        other => Err(Error::Invalid(format!("Not a path parameter: {other}"))),
    }
}

/// How each kind of argument goes on the wire.
pub mod enc {
    use super::*;

    pub type Encode<'a> = &'a dyn Fn(&Value) -> Result<Value>;

    /// A handle is sent by its id, or an object of its ids when it has several. Text is an id already.
    pub fn ref_ids(value: &Value, ids: &[&str]) -> Result<Value> {
        match value {
            Value::Null | Value::String(_) | Value::Number(_) => Ok(value.clone()),
            Value::Object(data) => match ids {
                [only] => data
                    .get(*only)
                    .cloned()
                    .ok_or_else(|| Error::Invalid(format!("A handle without its {only}"))),
                _ => Ok(Value::Object(
                    ids.iter()
                        .filter_map(|id| {
                            data.get(*id).map(|field| ((*id).to_owned(), field.clone()))
                        })
                        .collect(),
                )),
            },
            other => Err(Error::Invalid(format!("Not a handle: {other}"))),
        }
    }

    /// A duration is sent in milliseconds.
    pub fn duration(value: &Value) -> Result<Value> {
        if value.is_null() {
            return Ok(Value::Null);
        }
        Ok(serde_json::json!(parse_duration(value)?))
    }

    /// A list, each item encoded; with `one_or_many`, a single item is a list of one.
    pub fn array(value: &Value, one_or_many: bool, item: Encode) -> Result<Value> {
        match value {
            Value::Null => Ok(Value::Null),
            Value::Array(items) => Ok(Value::Array(items.iter().map(item).collect::<Result<_>>()?)),
            other if one_or_many => Ok(Value::Array(vec![item(other)?])),
            other => Err(Error::Invalid(format!("Not a list: {other}"))),
        }
    }

    /// An object whose fields hold handles: each encoded where it is. With a shorthand, a value
    /// that isn't such an object (text, or a handle) stands for `{ [shorthand]: value }`.
    pub fn object(
        value: &Value,
        shorthand: Option<(&str, Encode)>,
        fields: &[(&str, Encode)],
    ) -> Result<Value> {
        if let Some((name, encode)) = shorthand {
            let whole = value
                .as_object()
                .is_some_and(|data| data.contains_key(name));
            if !value.is_null() && !whole {
                let mut short = Map::new();
                short.insert(name.to_owned(), encode(value)?);
                return Ok(Value::Object(short));
            }
        }
        match value {
            Value::Object(data) => {
                let mut wire = data.clone();
                for (name, encode) in fields {
                    if let Some(field) = data.get(*name).filter(|field| !field.is_null()) {
                        wire.insert((*name).to_owned(), encode(field)?);
                    }
                }
                Ok(Value::Object(wire))
            }
            other => Ok(other.clone()),
        }
    }

    /// One of several types, told apart by the value's JSON kind: an object is encoded as the
    /// union's object member, a list as its list member, anything else goes as it is.
    pub fn union(value: &Value, object: Option<Encode>, list: Option<Encode>) -> Result<Value> {
        let encode = match value {
            Value::Object(_) => object,
            Value::Array(_) => list,
            _ => None,
        };
        encode.map_or_else(|| plain(value), |encode| encode(value))
    }

    /// An argument whose plain text stands for an object: `"hi"` for `{ "text": "hi" }`.
    pub fn shorthand(value: &Value, field: &str, encode: Encode) -> Result<Value> {
        match value {
            Value::String(_) => {
                let mut short = Map::new();
                short.insert(field.to_owned(), value.clone());
                Ok(Value::Object(short))
            }
            other => encode(other),
        }
    }

    /// As it is: plain values, named data in the API's own field names, and patterns.
    pub fn plain(value: &Value) -> Result<Value> {
        Ok(value.clone())
    }

    /// A credential left out comes from the environment (`CHANNELSTACK_SLACK_USER_{name}_TOKEN`).
    pub fn credential_or(value: Value, template: &str, sent: &Map<String, Value>) -> Value {
        if !value.is_null() {
            return value;
        }
        credential(template, sent).map_or(Value::Null, Value::String)
    }
}

/// Send one method's request: after the agent is quiet when the method asks for that, and again
/// while it is refused with one of `retry` (a button that isn't there yet).
#[allow(clippy::too_many_arguments)]
pub async fn send(
    ctx: &Ctx,
    verb: &str,
    path: String,
    body: Option<Map<String, Value>>,
    query: Option<Map<String, Value>>,
    once_quiet: bool,
    retry: &[&str],
) -> Result<Value> {
    if once_quiet {
        until_quiet(
            || ctx.quiet(),
            &Value::from(DEFAULT_TIMEOUT),
            &Value::from(DEFAULT_QUIET_FOR),
            false,
        )
        .await?;
    }
    if retry.is_empty() {
        return ctx.transport.request(verb, &path, body, query).await;
    }
    retry_while(retry, || {
        ctx.transport
            .request(verb, &path, body.clone(), query.clone())
    })
    .await
}

/// A method's request as it is being built: its arguments, and the options set so far.
pub struct Call<T> {
    pub(crate) ctx: Ctx,
    pub(crate) me: Value,
    pub(crate) args: Vec<Value>,
    pub(crate) options: Map<String, Value>,
    pub(crate) run: Run,
    pub(crate) wrap: fn(&Ctx, Value) -> Result<T>,
}

pub type Run =
    for<'a> fn(&'a Ctx, &'a Value, Vec<Value>, Map<String, Value>) -> BoxFuture<'a, Result<Value>>;

impl<T> Call<T> {
    pub fn new(
        ctx: &Ctx,
        me: &Value,
        args: Vec<Value>,
        run: Run,
        wrap: fn(&Ctx, Value) -> Result<T>,
    ) -> Self {
        Self {
            ctx: ctx.clone(),
            me: me.clone(),
            args,
            options: Map::new(),
            run,
            wrap,
        }
    }

    /// Set an option by its name in the API (`channel`, `timeout`).
    pub fn option(mut self, name: &str, value: impl IntoArg) -> Self {
        self.options.insert(name.to_owned(), value.into_arg());
        self
    }

    /// Send the request, and answer what it returns.
    pub async fn send(self) -> Result<T> {
        let data = (self.run)(&self.ctx, &self.me, self.args, self.options).await?;
        (self.wrap)(&self.ctx, data)
    }
}

impl<T: Send + 'static> IntoFuture for Call<T> {
    type Output = Result<T>;
    type IntoFuture = BoxFuture<'static, Result<T>>;
    fn into_future(self) -> Self::IntoFuture {
        Box::pin(self.send())
    }
}

/// Data as it came: what a method returns when it isn't a handle.
pub fn as_value(_: &Ctx, data: Value) -> Result<Value> {
    Ok(data)
}

/// A method that returns nothing.
pub fn as_unit(_: &Ctx, _: Value) -> Result<()> {
    Ok(())
}

/// Any handle by its resource's name, for code that calls methods by name (the smoke runner).
#[derive(Clone)]
pub struct Dyn {
    /// The resource it is a handle of (`SlackUser`), or `None` for plain data.
    pub resource: Option<&'static str>,
    pub ctx: Ctx,
    pub data: Value,
}
