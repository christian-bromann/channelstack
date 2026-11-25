//! Credentials from the environment: `CHANNELSTACK_<CHANNEL>_USER_<NAME>_TOKEN`.

use serde_json::{Map, Value};

/// A name as it appears in an environment variable: "Ana" → "ANA", "ana-smith" → "ANA_SMITH".
fn env_name(value: &str) -> String {
    let mut name = String::new();
    let mut gap = false;
    for character in value.chars().flat_map(char::to_uppercase) {
        if character.is_ascii_alphanumeric() {
            name.push(character);
            gap = false;
        } else if !gap {
            name.push('_');
            gap = true;
        }
    }
    name
}

/// A credential from the environment, when a test leaves it out.
///
/// `CHANNELSTACK_SLACK_USER_{name}_TOKEN` with `name: "Ana"` reads `CHANNELSTACK_SLACK_USER_ANA_TOKEN`.
/// Unset (or empty), it is `None`, and the object is fake: one test runs fake on every PR and
/// live where the variables are set.
pub fn credential(template: &str, values: &Map<String, Value>) -> Option<String> {
    let mut variable = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let end = rest[start..].find('}')? + start;
        variable.push_str(&rest[..start]);
        let value = values.get(&rest[start + 1..end])?;
        let text = match value {
            Value::String(text) => text.clone(),
            Value::Null => return None,
            other => other.to_string(),
        };
        variable.push_str(&env_name(&text));
        rest = &rest[end + 1..];
    }
    variable.push_str(rest);
    std::env::var(variable)
        .ok()
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::env_name;

    #[test]
    fn names() {
        assert_eq!(env_name("Ana"), "ANA");
        assert_eq!(env_name("ana-smith"), "ANA_SMITH");
        assert_eq!(env_name("ana.b  c"), "ANA_B_C");
    }
}
