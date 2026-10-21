use super::*;
use regex::Regex;

pub(super) type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
pub(super) struct Error {
    pub(super) code: String,
    pub(super) message: String,
    pub(super) retry: Option<i64>,
}
impl Error {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retry: None,
        }
    }
    pub fn rate(message: &str, retry: i64) -> Self {
        Self {
            code: "rate_limited".into(),
            message: message.into(),
            retry: Some(retry.max(1)),
        }
    }
    pub fn wire(&self) -> Value {
        let number = match self.code.as_str() {
            "invalid_params" => -32602,
            "method_not_found" => -32601,
            _ => -32000,
        };
        let mut data = json!({"code":self.code});
        if let Some(retry) = self.retry {
            data["retry_after"] = json!(retry);
        }
        json!({"code":number,"message":self.message,"data":data})
    }
}
impl From<scp_relay_store::StoreError> for Error {
    fn from(_: scp_relay_store::StoreError) -> Self {
        Self::new("unavailable", "storage unavailable")
    }
}
pub(super) fn invalid(message: &str) -> Error {
    Error::new("invalid_params", message)
}
pub(super) fn string<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
pub(super) fn fields(e: &Endpoint) -> Value {
    serde_json::from_str(&e.fields).unwrap_or_else(|_| json!({}))
}
pub(super) fn text(value: Option<&Value>, name: &str, max: usize) -> Result<Value> {
    match value {
        None | Some(Value::Null) => Ok(Value::Null),
        Some(Value::String(s)) => {
            let cleaned: String = s
                .chars()
                .filter(|c| (!c.is_control() || matches!(c, '\n' | '\r' | '\t')) && !matches!(*c, '\u{ad}'|'\u{61c}'|'\u{180e}'|'\u{200b}'|'\u{200e}'|'\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2060}'..='\u{2064}'|'\u{2066}'..='\u{206f}'|'\u{feff}'|'\u{fff9}'..='\u{fffb}'|'\u{e0001}'|'\u{e0020}'..='\u{e007f}'))
                .collect();
            let cleaned = cleaned.trim();
            if cleaned.encode_utf16().count() > max {
                return Err(Error::new(
                    "too_large",
                    &format!("{name} exceeds {max} characters"),
                ));
            }
            Ok(json!(cleaned))
        }
        _ => Err(invalid(&format!("{name} must be a string"))),
    }
}
macro_rules! pattern {
    ($pattern:literal, $value:expr $(,)?) => {{
        static PATTERN: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new($pattern).expect("valid pattern"));
        PATTERN.is_match($value)
    }};
}
pub(super) use pattern;
pub(super) fn handle(s: &str) -> bool {
    pattern!(r"^[a-z0-9][a-z0-9._-]{0,62}$", s) && !matches!(s, "user" | "me" | "relay")
}
pub(super) fn labels(value: Option<&Value>, grant: Option<&Grant>) -> Result<Value> {
    let mut v = match value {
        None | Some(Value::Null) => json!({}),
        Some(v) if v.is_object() => v.clone(),
        _ => return Err(invalid("labels must be an object")),
    };
    if let Some(g) = grant {
        for (key, value) in &g.labels {
            v[key] = json!(value);
        }
    }
    let map = v
        .as_object()
        .ok_or_else(|| invalid("labels must be an object"))?;
    if map.len() > 16 {
        return Err(Error::new("too_large", "at most 16 labels"));
    }
    let keys: Vec<String> = map.keys().cloned().collect();
    for key in keys {
        if !pattern!(r"^[a-z0-9][a-z0-9._-]{0,31}$", &key) {
            return Err(invalid("invalid label name"));
        }
        v[&key] = text(v.get(&key), "label", 128)?
            .as_str()
            .map_or_else(|| json!(""), |s| json!(s));
    }
    Ok(v)
}
pub(super) fn server_fields(p: &Value) -> Result<()> {
    for key in [
        "from",
        "id",
        "seq",
        "hop",
        "created_at",
        "auth",
        "expires_at",
        "relation",
        "link",
    ] {
        if p.get(key).is_some() {
            return Err(invalid(&format!("{key} is set by the relay")));
        }
    }
    Ok(())
}
fn scanner() -> &'static [(String, Regex)] {
    static PATTERNS: std::sync::LazyLock<Vec<(String, Regex)>> = std::sync::LazyLock::new(|| {
        [
            ("implementation token",r"\b(?:scp|kre|kwt)_[A-Za-z0-9_-]{16,}"),
            ("relay grant",r"\bkrt_[0-9a-f]{64}\b"),
            ("anthropic key",r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
            ("api key",r"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}"),
            ("github token",r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})"),
            ("aws key",r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
            ("private key",r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)"),
            ("jwt",r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}"),
            ("slack token",r"\bxox[abprs]-[A-Za-z0-9-]{20,}"),
            ("bearer token",r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{16,}"),
            ("aws secret",r#"(?i)aws[_-]?secret[_-]?(?:access[_-]?)?key["']?\s*[:=]\s*["']?[A-Za-z0-9+/]{40}"#),
        ].into_iter().filter_map(|(name,p)|Regex::new(&p.replace(r"\b",r"(?-u:\b)")).ok().map(|re|(name.into(),re))).collect()
    });
    &PATTERNS
}
pub(super) fn secret(value: &str) -> bool {
    scanner().iter().any(|(_, re)| re.is_match(value)) || assigned_secret(value)
}
pub(super) fn redact(value: &str) -> String {
    let mut out = value.to_owned();
    for (name, re) in scanner() {
        out = re
            .replace_all(&out, format!("[redacted {name}]"))
            .into_owned();
    }
    if let Some(re) = assigned_pattern() {
        out = re
            .replace_all(&out, |captures: &regex::Captures<'_>| {
                let value = captures.get(3).map_or("", |m| m.as_str());
                if value.bytes().any(|b| b.is_ascii_digit())
                    && value.bytes().any(|b| b.is_ascii_alphabetic())
                {
                    format!(
                        "{}[redacted assigned secret]",
                        captures.get(1).map_or("", |m| m.as_str())
                    )
                } else {
                    captures.get(0).map_or("", |m| m.as_str()).to_owned()
                }
            })
            .into_owned();
    }
    out
}
fn assigned_pattern() -> Option<&'static Regex> {
    static PATTERN: std::sync::LazyLock<Option<Regex>> = std::sync::LazyLock::new(|| {
        Regex::new(r#"(?i)(^|[^A-Za-z])((?:api[_-]?key|token|secret|password|passwd|credentials?)["']?\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9+/._~-]{19,}))"#).ok()
    });
    PATTERN.as_ref()
}
fn assigned_secret(s: &str) -> bool {
    assigned_pattern().is_some_and(|re| {
        re.captures_iter(s).any(|c| {
            c.get(3).is_some_and(|m| {
                m.as_str().bytes().any(|b| b.is_ascii_digit())
                    && m.as_str().bytes().any(|b| b.is_ascii_alphabetic())
            })
        })
    })
}

pub(super) fn no_secret(s: &str) -> Result<()> {
    if secret(s) {
        Err(Error::new(
            "secret_refused",
            "the input looks like it carries a credential",
        ))
    } else {
        Ok(())
    }
}
pub(super) fn seqs(p: &Value) -> Result<Vec<i64>> {
    let list = p["seqs"]
        .as_array()
        .ok_or_else(|| invalid("seqs must be a list"))?;
    if list.len() > 100 || list.iter().any(|v| v.as_i64().is_none_or(|n| n < 0)) {
        return Err(invalid("seqs must be a list of at most 100 sequences"));
    }
    let mut out: Vec<i64> = list.iter().filter_map(Value::as_i64).collect();
    out.sort_unstable();
    out.dedup();
    Ok(out)
}
pub(super) fn cursor(p: &Value) -> Result<i64> {
    match p.get("after") {
        None => Ok(0),
        Some(v) => v
            .as_i64()
            .filter(|n| *n >= 0)
            .ok_or_else(|| invalid("after is a seq")),
    }
}

pub(super) fn new_id(prefix: &str) -> String {
    crate::random(prefix).chars().take(32).collect()
}
