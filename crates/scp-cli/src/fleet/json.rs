//! JSON as JavaScript holds it: objects keep the order the broker wrote their keys in, array-index keys first, and print as
//! `JSON.stringify` does, so a reply the CLI passes on reads the same whichever broker wrote it.

use crate::args::js_string;
use scp_mcp::tools::js_num;
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

/// whether `key` is an array index, which a JavaScript object lists first, in numeric order
fn index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u64>()
        .ok()
        .filter(|n| *n < u64::from(u32::MAX))
        .map(|n| n as u32)
}

impl Json {
    /// `JSON.parse`, None where it would throw
    pub fn parse(text: &[u8]) -> Option<Json> {
        let text = std::str::from_utf8(text).ok()?;
        let mut parser = Parser {
            text: text.as_bytes(),
            source: text,
            at: 0,
        };
        parser.space();
        let value = parser.value(0)?;
        parser.space();
        (parser.at == parser.text.len()).then_some(value)
    }

    pub fn object(entries: Vec<(&str, Json)>) -> Json {
        Json::Obj(
            entries
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect(),
        )
    }

    pub fn str(text: impl Into<String>) -> Json {
        Json::Str(text.into())
    }

    /// a field of an object, None when it is absent or this is no object
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn items(&self) -> &[Json] {
        match self {
            Json::Arr(items) => items,
            _ => &[],
        }
    }

    /// `object[key] = value`: a key it has keeps its place
    pub fn set(&mut self, key: &str, value: Json) {
        if let Json::Obj(entries) = self {
            match entries.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = value,
                None => entries.push((key.to_owned(), value)),
            }
        }
    }

    /// `Object.entries`: array-index keys first, in numeric order, then the rest as written; none for anything but an object
    pub fn entries(&self) -> Vec<(&str, &Json)> {
        let Json::Obj(entries) = self else {
            return Vec::new();
        };
        let mut indexed: Vec<(u32, &str, &Json)> = entries
            .iter()
            .filter_map(|(k, v)| index(k).map(|i| (i, k.as_str(), v)))
            .collect();
        indexed.sort_by_key(|(i, _, _)| *i);
        indexed
            .into_iter()
            .map(|(_, k, v)| (k, v))
            .chain(
                entries
                    .iter()
                    .filter(|(k, _)| index(k).is_none())
                    .map(|(k, v)| (k.as_str(), v)),
            )
            .collect()
    }

    pub fn to_value(&self) -> Value {
        match self {
            Json::Null => Value::Null,
            Json::Bool(on) => Value::Bool(*on),
            Json::Num(n) => {
                if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
                    Value::from(*n as i64)
                } else {
                    Value::from(*n)
                }
            }
            Json::Str(text) => Value::String(text.clone()),
            Json::Arr(items) => Value::Array(items.iter().map(Json::to_value).collect()),
            Json::Obj(entries) => Value::Object(
                entries
                    .iter()
                    .map(|(k, v)| (k.clone(), v.to_value()))
                    .collect::<Map<_, _>>(),
            ),
        }
    }

    /// `JSON.stringify(value)`
    pub fn compact(&self) -> String {
        let mut text = String::new();
        self.write(&mut text, None, 0);
        text
    }

    /// `JSON.stringify(value, null, 2)`
    pub fn pretty(&self) -> String {
        let mut text = String::new();
        self.write(&mut text, Some(2), 0);
        text
    }

    fn write(&self, text: &mut String, indent: Option<usize>, depth: usize) {
        let open = |text: &mut String, depth: usize| {
            if let Some(width) = indent {
                text.push('\n');
                text.push_str(&" ".repeat(width * depth));
            }
        };
        match self {
            Json::Null => text.push_str("null"),
            Json::Bool(on) => text.push_str(if *on { "true" } else { "false" }),
            Json::Num(n) if n.is_finite() => text.push_str(&js_num(*n)),
            Json::Num(_) => text.push_str("null"),
            Json::Str(s) => text.push_str(&js_string(s)),
            Json::Arr(items) if items.is_empty() => text.push_str("[]"),
            Json::Arr(items) => {
                text.push('[');
                for (at, item) in items.iter().enumerate() {
                    if at > 0 {
                        text.push(',');
                    }
                    open(text, depth + 1);
                    item.write(text, indent, depth + 1);
                }
                open(text, depth);
                text.push(']');
            }
            Json::Obj(entries) if entries.is_empty() => text.push_str("{}"),
            Json::Obj(_) => {
                text.push('{');
                for (at, (key, value)) in self.entries().into_iter().enumerate() {
                    if at > 0 {
                        text.push(',');
                    }
                    open(text, depth + 1);
                    text.push_str(&js_string(key));
                    text.push(':');
                    if indent.is_some() {
                        text.push(' ');
                    }
                    value.write(text, indent, depth + 1);
                }
                open(text, depth);
                text.push('}');
            }
        }
    }
}

impl From<&Value> for Json {
    fn from(value: &Value) -> Json {
        match value {
            Value::Null => Json::Null,
            Value::Bool(on) => Json::Bool(*on),
            Value::Number(n) => Json::Num(n.as_f64().unwrap_or(f64::NAN)),
            Value::String(s) => Json::Str(s.clone()),
            Value::Array(items) => Json::Arr(items.iter().map(Json::from).collect()),
            Value::Object(map) => Json::Obj(
                map.iter()
                    .map(|(k, v)| (k.clone(), Json::from(v)))
                    .collect(),
            ),
        }
    }
}

/// nesting past this fails the parse, as a deep enough input overflows JavaScript's stack
const DEPTH: usize = 4096;

struct Parser<'a> {
    text: &'a [u8],
    source: &'a str,
    at: usize,
}

impl Parser<'_> {
    fn space(&mut self) {
        while matches!(self.text.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn eat(&mut self, byte: u8) -> bool {
        let found = self.text.get(self.at) == Some(&byte);
        if found {
            self.at += 1;
        }
        found
    }

    fn word(&mut self, word: &str, value: Json) -> Option<Json> {
        self.text[self.at..].starts_with(word.as_bytes()).then(|| {
            self.at += word.len();
            value
        })
    }

    fn value(&mut self, depth: usize) -> Option<Json> {
        if depth > DEPTH {
            return None;
        }
        match self.text.get(self.at)? {
            b'n' => self.word("null", Json::Null),
            b't' => self.word("true", Json::Bool(true)),
            b'f' => self.word("false", Json::Bool(false)),
            b'"' => self.string().map(Json::Str),
            b'[' => {
                self.at += 1;
                let mut items = Vec::new();
                self.space();
                if self.eat(b']') {
                    return Some(Json::Arr(items));
                }
                loop {
                    self.space();
                    items.push(self.value(depth + 1)?);
                    self.space();
                    if self.eat(b']') {
                        return Some(Json::Arr(items));
                    }
                    if !self.eat(b',') {
                        return None;
                    }
                }
            }
            b'{' => {
                self.at += 1;
                let mut object = Json::Obj(Vec::new());
                self.space();
                if self.eat(b'}') {
                    return Some(object);
                }
                loop {
                    self.space();
                    if self.text.get(self.at) != Some(&b'"') {
                        return None;
                    }
                    let key = self.string()?;
                    self.space();
                    if !self.eat(b':') {
                        return None;
                    }
                    self.space();
                    let value = self.value(depth + 1)?;
                    object.set(&key, value);
                    self.space();
                    if self.eat(b'}') {
                        return Some(object);
                    }
                    if !self.eat(b',') {
                        return None;
                    }
                }
            }
            _ => self.number(),
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while self.text.get(self.at).is_some_and(u8::is_ascii_digit) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Option<Json> {
        let start = self.at;
        self.eat(b'-');
        if self.eat(b'0') {
            if self.text.get(self.at).is_some_and(u8::is_ascii_digit) {
                return None;
            }
        } else if self.digits() == 0 {
            return None;
        }
        if self.eat(b'.') && self.digits() == 0 {
            return None;
        }
        if self.eat(b'e') || self.eat(b'E') {
            if !self.eat(b'+') {
                self.eat(b'-');
            }
            if self.digits() == 0 {
                return None;
            }
        }
        self.source[start..self.at].parse().ok().map(Json::Num)
    }

    fn hex4(&mut self) -> Option<u32> {
        let digits = self.source.get(self.at..self.at + 4)?;
        let unit = u32::from_str_radix(digits, 16).ok()?;
        if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        self.at += 4;
        Some(unit)
    }

    fn string(&mut self) -> Option<String> {
        self.at += 1;
        let mut units: Vec<u16> = Vec::new();
        let mut out = String::new();
        let flush = |units: &mut Vec<u16>, out: &mut String| {
            out.push_str(&String::from_utf16_lossy(units));
            units.clear();
        };
        loop {
            let start = self.at;
            while let Some(&b) = self.text.get(self.at) {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.at += 1;
            }
            if self.at > start {
                flush(&mut units, &mut out);
                out.push_str(&self.source[start..self.at]);
            }
            match self.text.get(self.at)? {
                b'"' => {
                    self.at += 1;
                    flush(&mut units, &mut out);
                    return Some(out);
                }
                b'\\' => {
                    self.at += 1;
                    let escape = *self.text.get(self.at)?;
                    self.at += 1;
                    let unit = match escape {
                        b'"' => 0x22,
                        b'\\' => 0x5c,
                        b'/' => 0x2f,
                        b'b' => 0x08,
                        b'f' => 0x0c,
                        b'n' => 0x0a,
                        b'r' => 0x0d,
                        b't' => 0x09,
                        b'u' => self.hex4()?,
                        _ => return None,
                    };
                    units.push(unit as u16);
                }
                _ => return None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round(text: &str) -> String {
        Json::parse(text.as_bytes()).unwrap().compact()
    }

    #[test]
    fn objects_keep_the_order_written_with_array_indexes_first() {
        assert_eq!(
            round(r#"{"z":1,"b":{"y":true,"a":null},"10":0,"2":0,"02":0,"a":[]}"#),
            r#"{"2":0,"10":0,"z":1,"b":{"y":true,"a":null},"02":0,"a":[]}"#
        );
        assert_eq!(round(r#"{"a":1,"b":2,"a":3}"#), r#"{"a":3,"b":2}"#);
        assert_eq!(
            round(r#"{"4294967295":1,"4294967294":2}"#),
            r#"{"4294967294":2,"4294967295":1}"#
        );
    }

    #[test]
    fn numbers_and_strings_print_as_javascript_writes_them() {
        assert_eq!(
            round("[1.0, 1e21, 1E-7, -0, 0.5, 123456789012345678901]"),
            "[1,1e+21,1e-7,0,0.5,123456789012345680000]"
        );
        assert_eq!(
            round(r#""a\/b\u00e9\ud83d\ude00\u0001\n""#),
            "\"a/bé😀\\u0001\\n\""
        );
        assert_eq!(round(r#""\ud800x""#), "\"\u{fffd}x\"");
        assert_eq!(
            Json::parse(br#" {"a": [1, {"b": []}], "c": {}} "#)
                .unwrap()
                .pretty(),
            "{\n  \"a\": [\n    1,\n    {\n      \"b\": []\n    }\n  ],\n  \"c\": {}\n}"
        );
    }

    #[test]
    fn what_json_parse_refuses_fails() {
        for text in [
            "",
            "{",
            "[1,]",
            "01",
            "1.",
            "-",
            "\"\t\"",
            "{\"a\" 1}",
            "nul",
            "1 2",
            "\"\\x\"",
            "\"\\u12g4\"",
        ] {
            assert_eq!(Json::parse(text.as_bytes()), None, "{text}");
        }
    }
}
