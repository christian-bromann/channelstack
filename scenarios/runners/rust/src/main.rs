//! Runs a smoke scenario (docs/decisions/0002-smoke-scenario-format.md) through the Rust SDK.
//! Usage: `channelstack-smoke <scenario.yaml> [--mode auto|attach|start]`
//!
//! The same YAML runs through every SDK's runner: here, each step calls the method by its name in
//! the API through the SDK's generated `call_by_name`, with the handles and values the scenario
//! saved.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use channelstack::{Dyn, Error, Mode, call_by_name, connect, field_resource};
use regex::Regex;
use serde_json::{Map, Value};
use yaml_rust2::{Yaml, YamlLoader};

/// A saved value: a handle (methods can be called on it), or data.
#[derive(Clone)]
enum Saved {
    Handle(Dyn),
    Data(Value),
}

impl Saved {
    fn data(&self) -> Value {
        match self {
            Saved::Handle(handle) => handle.data.clone(),
            Saved::Data(value) => value.clone(),
        }
    }
}

/// YAML as JSON: what the SDK takes and returns.
fn json(yaml: &Yaml) -> Value {
    match yaml {
        Yaml::Real(text) => text.parse::<f64>().map(Value::from).unwrap_or(Value::Null),
        Yaml::Integer(number) => Value::from(*number),
        Yaml::String(text) => Value::String(text.clone()),
        Yaml::Boolean(flag) => Value::Bool(*flag),
        Yaml::Array(items) => Value::Array(items.iter().map(json).collect()),
        Yaml::Hash(entries) => Value::Object(
            entries
                .iter()
                .filter_map(|(key, value)| key.as_str().map(|key| (key.to_owned(), json(value))))
                .collect(),
        ),
        _ => Value::Null,
    }
}

struct Runner {
    variables: HashMap<String, Saved>,
}

impl Runner {
    /// One step into a value: an array index or `length`, or a property; a handle's field that is
    /// a handle stays one. Missing values read as null.
    fn step(saved: Saved, key: &str) -> Saved {
        if let Saved::Handle(handle) = &saved
            && let Some(resource) = handle
                .resource
                .and_then(|resource| field_resource(resource, key))
        {
            return Saved::Handle(Dyn {
                resource: Some(resource),
                ctx: handle.ctx.clone(),
                data: handle.data.get(key).cloned().unwrap_or(Value::Null),
            });
        }
        let data = saved.data();
        Saved::Data(match (&data, key) {
            (Value::Array(items), "length") => Value::from(items.len()),
            (Value::Array(items), index) => index
                .parse::<usize>()
                .ok()
                .and_then(|at| items.get(at).cloned())
                .unwrap_or(Value::Null),
            (Value::Object(fields), name) => fields.get(name).cloned().unwrap_or(Value::Null),
            _ => Value::Null,
        })
    }

    /// `$name.path.to.value` → the saved value; `$$` is a literal `$`.
    fn reference(&self, text: &str) -> Result<Saved, String> {
        let mut path = text[1..].split('.');
        let name = path.next().unwrap_or_default();
        let start = self
            .variables
            .get(name)
            .cloned()
            .ok_or_else(|| format!("Unknown variable ${name}"))?;
        Ok(path.fold(start, Runner::step))
    }

    /// A value with every reference in it resolved: handles become their data, which the SDK sends by id.
    fn resolve(&self, value: &Value) -> Result<Value, String> {
        Ok(match value {
            Value::String(text) if text.starts_with("$$") => Value::String(text[1..].to_owned()),
            Value::String(text) if text.starts_with('$') => self.reference(text)?.data(),
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|item| self.resolve(item))
                    .collect::<Result<_, _>>()?,
            ),
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .map(|(key, item)| Ok((key.clone(), self.resolve(item)?)))
                    .collect::<Result<_, String>>()?,
            ),
            other => other.clone(),
        })
    }

    /// Does `actual` have everything `expected` asks for? Mappings match partially, everything else exactly.
    fn matches(actual: &Value, expected: &Value) -> bool {
        match expected {
            Value::Object(fields) => fields.iter().all(|(key, value)| {
                Runner::matches(actual.get(key).unwrap_or(&Value::Null), value)
            }),
            other => actual == other,
        }
    }

    fn failure(&self, check: &Value) -> Result<Option<String>, String> {
        let actual = self.resolve(check.get("value").unwrap_or(&Value::Null))?;
        let shown = format!(
            "{} = {}",
            check.get("value").unwrap_or(&Value::Null),
            actual
        );
        if let Some(expected) = check.get("equals") {
            let expected = self.resolve(expected)?;
            if !Runner::matches(&actual, &expected) {
                return Ok(Some(format!("{shown}, expected {expected}")));
            }
        }
        if let Some(pattern) = check.get("matches").and_then(Value::as_str) {
            let regex = Regex::new(pattern).map_err(|error| error.to_string())?;
            if !actual.as_str().is_some_and(|text| regex.is_match(text)) {
                return Ok(Some(format!("{shown}, expected a match for /{pattern}/")));
            }
        }
        if let Some(wanted) = check.get("contains") {
            let wanted = self.resolve(wanted)?;
            if !actual
                .as_array()
                .is_some_and(|items| items.iter().any(|item| Runner::matches(item, &wanted)))
            {
                return Ok(Some(format!("{shown}, expected it to contain {wanted}")));
            }
        }
        Ok(None)
    }

    fn first_failure(&self, checks: &Value) -> Result<Option<String>, String> {
        for check in checks.as_array().into_iter().flatten() {
            if let Some(failed) = self.failure(check)? {
                return Ok(Some(failed));
            }
        }
        Ok(None)
    }

    async fn call(&self, step: &Value) -> Result<Result<Dyn, Error>, String> {
        let call = step.get("call").and_then(Value::as_str).unwrap_or_default();
        // `<variable>.<method>`, or a method on a handle inside one: `message.thread.waitForReply`.
        let (target, method) = call
            .rsplit_once('.')
            .ok_or_else(|| format!("{call}: not a method call"))?;
        let Saved::Handle(handle) = self.reference(&format!("${target}"))? else {
            return Err(format!("{call}: {target} is not a handle"));
        };
        let args = match step.get("args") {
            Some(args) => self.resolve(args)?.as_array().cloned().unwrap_or_default(),
            None => vec![],
        };
        let options: Map<String, Value> = match step.get("options") {
            Some(options) => self
                .resolve(options)?
                .as_object()
                .cloned()
                .unwrap_or_default(),
            None => Map::new(),
        };
        Ok(call_by_name(&handle, method, args, options).await)
    }

    async fn run(&mut self, step: &Value, number: usize) -> Result<(), String> {
        if let Some(checks) = step.get("expect")
            && let Some(failed) = self.first_failure(checks)?
        {
            return Err(format!("step {number}: {failed}"));
        }
        let Some(call) = step.get("call").and_then(Value::as_str) else {
            return Ok(());
        };
        if let Some(code) = step.get("throws").and_then(Value::as_str) {
            return match self.call(step).await? {
                Err(error) if error.code() == Some(code) => Ok(()),
                Err(error) => Err(format!(
                    "step {number}: {call} should fail with {code}, got {error}"
                )),
                Ok(_) => Err(format!(
                    "step {number}: {call} should fail with {code}, got no error"
                )),
            };
        }
        let until = step.get("until");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let result = self
                .call(step)
                .await?
                .map_err(|error| format!("step {number}: {call}: {error}"))?;
            let saved = if result.resource.is_some() {
                Saved::Handle(result)
            } else {
                Saved::Data(result.data)
            };
            if let Some(name) = step.get("as").and_then(Value::as_str) {
                self.variables.insert(name.to_owned(), saved);
            }
            let Some(checks) = until else {
                return Ok(());
            };
            match self.first_failure(checks)? {
                None => return Ok(()),
                Some(failed) if Instant::now() > deadline => {
                    return Err(format!("step {number}: {failed}"));
                }
                Some(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
    }
}

#[tokio::main]
async fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let Some(file) = arguments.first() else {
        eprintln!("Usage: channelstack-smoke <scenario.yaml> [--mode auto|attach|start]");
        std::process::exit(2);
    };
    let mode = match arguments
        .iter()
        .position(|argument| argument == "--mode")
        .and_then(|at| arguments.get(at + 1))
        .map(String::as_str)
    {
        Some("attach") => Mode::Attach,
        Some("start") => Mode::Start,
        _ => Mode::Auto,
    };
    let text = std::fs::read_to_string(file).unwrap_or_else(|error| panic!("{file}: {error}"));
    let documents =
        YamlLoader::load_from_str(&text).unwrap_or_else(|error| panic!("{file}: {error}"));
    let scenario = json(&documents[0]);
    let name = scenario
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(file)
        .to_owned();
    let steps = scenario
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let client = connect(mode)
        .await
        .unwrap_or_else(|error| panic!("connect: {error}"));
    let root = Dyn {
        resource: Some("Channelstack"),
        ctx: channelstack::Handle::ctx(&client).clone(),
        data: Value::Null,
    };
    let session = call_by_name(&root, "openSession", vec![], Map::new())
        .await
        .unwrap_or_else(|error| panic!("openSession: {error}"));
    let mut runner = Runner {
        variables: HashMap::new(),
    };
    runner
        .variables
        .insert("channelstack".into(), Saved::Handle(root));
    runner
        .variables
        .insert("session".into(), Saved::Handle(session.clone()));

    let mut outcome = Ok(());
    for (index, step) in steps.iter().enumerate() {
        if let Err(failed) = runner.run(step, index + 1).await {
            outcome = Err(failed);
            break;
        }
    }
    // The session is closed and a server this runner started is stopped, whatever happened.
    let _ = call_by_name(&session, "close", vec![], Map::new()).await;
    client.close().await;
    match outcome {
        Ok(()) => println!("ok {name} (rust, {} steps)", steps.len()),
        Err(failed) => {
            eprintln!("{name}: {failed}");
            std::process::exit(1);
        }
    }
}
