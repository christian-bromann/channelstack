//! Durations: milliseconds as a number, or "250ms", "3s", "1m".

use serde_json::Value;

use super::error::{Error, Result};

/// A duration in milliseconds, from a number of milliseconds or text like "3s".
pub fn parse_duration(duration: &Value) -> Result<f64> {
    match duration {
        Value::Number(number) => {
            let ms = number.as_f64().unwrap_or(-1.0);
            if ms.is_finite() && ms >= 0.0 {
                Ok(ms)
            } else {
                Err(Error::Invalid(format!("Not a duration: {number}")))
            }
        }
        Value::String(text) => {
            let (amount, unit) = if let Some(amount) = text.strip_suffix("ms") {
                (amount, 1.0)
            } else if let Some(amount) = text.strip_suffix('s') {
                (amount, 1000.0)
            } else if let Some(amount) = text.strip_suffix('m') {
                (amount, 60_000.0)
            } else {
                ("", 0.0)
            };
            match amount.parse::<f64>() {
                Ok(value) if unit > 0.0 && value >= 0.0 && !amount.starts_with('+') => {
                    Ok(value * unit)
                }
                _ => Err(Error::Invalid(format!(
                    "Not a duration: \"{text}\". Use milliseconds, or \"250ms\", \"3s\", \"1m\"."
                ))),
            }
        }
        other => Err(Error::Invalid(format!("Not a duration: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_duration;
    use serde_json::json;

    #[test]
    fn durations() {
        assert_eq!(parse_duration(&json!("750ms")).unwrap(), 750.0);
        assert_eq!(parse_duration(&json!("3s")).unwrap(), 3000.0);
        assert_eq!(parse_duration(&json!("1m")).unwrap(), 60_000.0);
        assert_eq!(parse_duration(&json!(250)).unwrap(), 250.0);
        assert!(parse_duration(&json!("soon")).is_err());
        assert!(parse_duration(&json!(-1)).is_err());
    }
}
