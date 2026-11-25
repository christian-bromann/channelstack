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
            // The grammar every SDK accepts: digits, an optional fraction, and a unit.
            let pattern =
                regex::Regex::new(r"^(\d+(?:\.\d+)?)(ms|s|m)$").expect("the duration pattern");
            let unit = |unit: &str| match unit {
                "ms" => 1.0,
                "s" => 1000.0,
                _ => 60_000.0,
            };
            pattern
                .captures(text)
                .and_then(|found| Some(found[1].parse::<f64>().ok()? * unit(&found[2])))
                .filter(|ms| ms.is_finite())
                .ok_or_else(|| {
                    Error::Invalid(format!(
                        "Not a duration: \"{text}\". Use milliseconds, or \"250ms\", \"3s\", \"1m\"."
                    ))
                })
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
        assert_eq!(parse_duration(&json!("1.5s")).unwrap(), 1500.0);
        // What the other SDKs refuse, this one refuses too.
        for refused in ["1e3ms", "-0s", "infs", "NaNs", "+1s", "1 s", "s", "1h"] {
            assert!(parse_duration(&json!(refused)).is_err(), "{refused}");
        }
    }
}
