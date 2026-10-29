use scp_core::protocol::*;
use std::{fs, path::Path};

fn strip_comments(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut clean = Vec::with_capacity(bytes.len());
    let mut cursor = 0;
    let mut quote = None;
    while cursor < bytes.len() {
        let c = bytes[cursor];
        if let Some(delimiter) = quote {
            clean.push(c);
            cursor += 1;
            if c == b'\\' && cursor < bytes.len() {
                clean.push(bytes[cursor]);
                cursor += 1;
            } else if c == delimiter {
                quote = None;
            }
        } else if c == b'"' || c == b'\'' || c == b'`' {
            quote = Some(c);
            clean.push(c);
            cursor += 1;
        } else if bytes[cursor..].starts_with(b"//") {
            while cursor < bytes.len() && bytes[cursor] != b'\n' {
                cursor += 1;
            }
        } else if bytes[cursor..].starts_with(b"/*") {
            cursor += 2;
            while cursor < bytes.len() && !bytes[cursor..].starts_with(b"*/") {
                cursor += 1;
            }
            assert!(cursor < bytes.len(), "unterminated comment");
            cursor += 2;
            clean.push(b' ');
        } else {
            clean.push(c);
            cursor += 1;
        }
    }
    String::from_utf8(clean).unwrap()
}

fn constant<'a>(source: &'a str, name: &str) -> &'a str {
    let marker = format!("export const {name}");
    let start = source
        .match_indices(&marker)
        .find_map(|(start, _)| {
            let tail = &source[start + marker.len()..];
            (!tail.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')).then_some(tail)
        })
        .unwrap_or_else(|| panic!("missing {name}"));
    start.split_once('=').unwrap().1.trim_start()
}

fn strings(source: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut rest = source;
    while let Some(start) = rest.find('"') {
        rest = &rest[start..];
        let mut end = 1;
        let bytes = rest.as_bytes();
        while end < bytes.len() {
            if bytes[end] == b'\\' {
                end += 2;
            } else if bytes[end] == b'"' {
                break;
            } else {
                end += 1;
            }
        }
        values.push(serde_json::from_str(&rest[..=end]).unwrap());
        rest = &rest[end + 1..];
    }
    values
}

fn array(source: &str, name: &str) -> Vec<String> {
    let rhs = constant(source, name);
    let body = rhs.split_once('[').unwrap().1.split_once(']').unwrap().0;
    body.split(',')
        .filter_map(|item| {
            let item = item.trim();
            if item.is_empty() { None } else { Some(item) }
        })
        .flat_map(|item| {
            if let Some(spread) = item.strip_prefix("...") {
                array(source, spread)
            } else {
                vec![serde_json::from_str::<String>(item).unwrap()]
            }
        })
        .collect()
}

fn product(expression: &str) -> Option<u64> {
    let expression = expression.trim();
    if expression == "Infinity" {
        return None;
    }
    Some(
        expression
            .split('*')
            .map(|factor| factor.trim().replace('_', "").parse::<u64>().unwrap())
            .try_fold(1_u64, |value, factor| value.checked_mul(factor))
            .unwrap(),
    )
}

fn object(source: &str, name: &str) -> Vec<(String, Option<u64>)> {
    let rhs = constant(source, name);
    let body = rhs.strip_prefix('{').unwrap().split_once('}').unwrap().0;
    body.split(',')
        .filter(|item| !item.trim().is_empty())
        .map(|item| {
            let (key, value) = item.split_once(':').unwrap();
            (key.trim().to_owned(), product(value))
        })
        .collect()
}

fn assert_strings(source: &str, name: &str, actual: impl IntoIterator<Item = impl ToString>) {
    let actual: Vec<String> = actual.into_iter().map(|value| value.to_string()).collect();
    assert_eq!(array(source, name), actual, "{name} drift");
}

#[test]
fn protocol_constants_match_source() {
    let path = Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/core/src/protocol.ts"
    ));
    if !path.exists() {
        return;
    }
    let source = strip_comments(&fs::read_to_string(path).unwrap());
    let limits = object(&source, "LIMITS");
    assert_eq!(
        limits
            .iter()
            .map(|(key, _)| key.as_str())
            .collect::<Vec<_>>(),
        Limits::KEYS,
        "LIMITS keys drift"
    );
    for (key, value) in limits {
        assert_eq!(LIMITS.get(&key), value, "LIMITS.{key} drift");
    }
    let rates = object(&source, "RATE_LIMITS");
    assert_eq!(
        rates
            .iter()
            .map(|(key, _)| key.as_str())
            .collect::<Vec<_>>(),
        RateLimits::KEYS,
        "RATE_LIMITS keys drift"
    );
    for (key, value) in rates {
        assert_eq!(
            RATE_LIMITS.get(&key),
            Some(value),
            "RATE_LIMITS.{key} drift"
        );
    }
    let error_union = source
        .split_once("export type ErrorCode =")
        .unwrap()
        .1
        .split_once("export class")
        .unwrap()
        .0;
    assert_eq!(
        strings(error_union),
        ERROR_CODES
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        "ErrorCode drift"
    );
    assert_strings(&source, "RATE_DURATIONS", RATE_DURATIONS);
    assert_strings(&source, "CAPABILITIES", CAPABILITIES);
    assert_strings(&source, "BROKER_CAPABILITIES", BROKER_CAPABILITIES);
    assert_strings(&source, "WAKES", WAKES);
    assert_strings(&source, "BROKER_WAKES", BROKER_WAKES);
    assert_strings(&source, "PRESENCES", PRESENCES);
    assert_strings(&source, "ACTIVITY_KINDS", ACTIVITY_KINDS);
    assert_strings(&source, "MESSAGE_KINDS", MESSAGE_KINDS);
    assert_strings(&source, "STATUS_STATES", STATUS_STATES);
    assert_strings(&source, "SCOPE_PRESETS", SCOPE_PRESETS);
    assert_strings(&source, "SERVER_FIELDS", SERVER_FIELDS);
    assert_strings(&source, "GENERIC_HARNESSES", GENERIC_HARNESSES);
    let hop_floor = constant(&source, "HOP_FLOOR_MAX").lines().next().unwrap();
    assert_eq!(
        product(hop_floor),
        Some(HOP_FLOOR_MAX),
        "HOP_FLOOR_MAX drift"
    );
    for (name, actual) in [("PROTOCOL", PROTOCOL), ("CLI_NAME", CLI_NAME)] {
        let literal = constant(&source, name).lines().next().unwrap();
        assert_eq!(
            serde_json::from_str::<String>(literal).unwrap(),
            actual,
            "{name} drift"
        );
    }
}

#[test]
fn source_parser_handles_comments_products_and_spreads() {
    let source = strip_comments(
        r#"
        export const BASE = ["a//b", "c/*d*/"] // comment
        export const MORE = [...BASE, /** block */ "e"]
        export const LIMITS = { n: 7 * 86_400, /* block */ off: Infinity, }
    "#,
    );
    assert_eq!(array(&source, "MORE"), ["a//b", "c/*d*/", "e"]);
    assert_eq!(
        object(&source, "LIMITS"),
        [("n".into(), Some(604_800)), ("off".into(), None)]
    );
}
