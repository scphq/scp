use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::address::valid_account;

pub type Selector = String;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeSubject {
    pub id: String,
    pub tree: String,
    pub ancestors: Vec<String>,
    pub groups: Vec<String>,
    pub root_handle: String,
    pub machine: Option<String>,
    pub local: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicySubject {
    pub handle: String,
    pub harness: Option<String>,
    pub kind: String,
    pub labels: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<ScopeSubject>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
}

fn lower_digit(c: u8) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit()
}

fn name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && lower_digit(s.as_bytes()[0])
        && s.bytes().all(|c| lower_digit(c) || b"._-".contains(&c))
}

pub fn valid_group_name(s: &str) -> bool {
    name(s)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ValidSelectorOptions {
    pub absolute: bool,
    pub group_rules: bool,
}

fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn valid_selector(s: &str, options: ValidSelectorOptions) -> bool {
    if s == "group:self" {
        return options.group_rules;
    }
    if s == "*" {
        return true;
    }
    let Some((kind, value)) = s.split_once(':') else {
        return false;
    };
    match kind {
        "ep" => name(value),
        "handle" => {
            !value.is_empty()
                && value.len() <= 63
                && value
                    .bytes()
                    .all(|c| lower_digit(c) || b"._*-".contains(&c))
        }
        "harness" => {
            !value.is_empty()
                && value.len() <= 32
                && value.bytes().all(|c| lower_digit(c) || c == b'-')
        }
        "kind" => matches!(value, "agent" | "human"),
        "label" => value.split_once('=').is_some_and(|(key, value)| {
            !key.is_empty()
                && key.len() <= 32
                && key.bytes().all(|c| lower_digit(c) || b"._-".contains(&c))
                && value.encode_utf16().count() <= 128
                && !value.chars().any(js_whitespace)
        }),
        "group" => {
            name(value)
                || value
                    .split_once('/')
                    .is_some_and(|(a, b)| name(a) && name(b))
        }
        "fleet" | "org" => value == "*" || name(value),
        "machine" => {
            !value.is_empty()
                && value.len() <= 63
                && value.as_bytes()[0].is_ascii_alphanumeric()
                && value
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        }
        "acct" => value == "*" || valid_account(value),
        "tree" if !options.absolute => {
            if matches!(value, "self" | "root" | "parent" | "siblings" | "children") {
                return true;
            }
            let (rel, depth) = value
                .split_once(':')
                .map_or((value, None), |(r, d)| (r, Some(d)));
            matches!(rel, "ancestors" | "descendants")
                && depth.is_none_or(|d| {
                    matches!(
                        d,
                        "1" | "2"
                            | "3"
                            | "4"
                            | "5"
                            | "6"
                            | "7"
                            | "8"
                            | "9"
                            | "10"
                            | "11"
                            | "12"
                            | "13"
                            | "14"
                            | "15"
                            | "16"
                    )
                })
        }
        _ => false,
    }
}

fn glob(pattern: &str, value: &str) -> bool {
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let (mut p, mut v, mut retry) = (0, 0, 0);
    let mut star = None;
    while v < value.len() {
        if p < pattern.len() && pattern[p] != b'*' && pattern[p] == value[v] {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry = v;
        } else if let Some(s) = star {
            if matches!(value[retry], b'\n' | b'\r')
                || value[retry..].starts_with(&[0xe2, 0x80, 0xa8])
                || value[retry..].starts_with(&[0xe2, 0x80, 0xa9])
            {
                return false;
            }
            p = s + 1;
            retry += 1;
            v = retry;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

pub fn matches(
    selector: &str,
    subject: &PolicySubject,
    anchor: Option<&PolicySubject>,
    bound: Option<&dyn Fn(&str) -> bool>,
) -> bool {
    if let Some(account) = &subject.account {
        return selector == "acct:*" || selector == format!("acct:{account}");
    }
    if selector == "*" {
        return true;
    }
    let Some((kind, value)) = selector.split_once(':') else {
        return false;
    };
    let x = subject.scope.as_ref();
    match kind {
        "ep" => subject.kind == "agent" && subject.handle == value,
        "handle" => subject.kind == "agent" && glob(value, &subject.handle),
        "harness" => subject.harness.as_deref() == Some(value),
        "kind" => subject.kind == value,
        "label" => {
            let (key, value) = value.split_once('=').unwrap_or_else(|| {
                let key = value
                    .char_indices()
                    .next_back()
                    .map_or("", |(i, _)| &value[..i]);
                (key, value)
            });
            subject.labels.get(key).is_some_and(|v| v == value)
        }
        "group" => x.is_some_and(|x| {
            !value.contains('/')
                && value != "self"
                && x.groups.iter().any(|g| g == value)
                && bound.is_none_or(|bound| bound(value))
        }),
        "fleet" => x.is_some_and(|x| {
            x.local && subject.kind == "agent" && (value == "*" || x.root_handle == value)
        }),
        "machine" => x.is_some_and(|x| x.machine.as_deref() == Some(value)),
        "tree" => {
            let Some((x, a)) = x
                .zip(anchor.and_then(|a| a.scope.as_ref()))
                .filter(|(x, a)| x.local && a.local && x.tree == a.tree)
            else {
                return false;
            };
            let mut parts = value.split(':');
            let rel = parts.next().unwrap_or_default();
            let n = parts.next().map_or(f64::INFINITY, |d| {
                if d.trim().is_empty() {
                    0.0
                } else {
                    d.parse().unwrap_or(f64::NAN)
                }
            });
            match rel {
                "self" => true,
                "root" => x.id == a.tree,
                "parent" => a.ancestors.first() == Some(&x.id),
                "ancestors" => a
                    .ancestors
                    .iter()
                    .position(|id| id == &x.id)
                    .is_some_and(|i| (i as f64) < n),
                "children" => x.ancestors.first() == Some(&a.id),
                "descendants" => x
                    .ancestors
                    .iter()
                    .position(|id| id == &a.id)
                    .is_some_and(|i| (i as f64) < n),
                "siblings" => {
                    x.id != a.id
                        && !a.ancestors.is_empty()
                        && x.ancestors.first() == a.ancestors.first()
                }
                _ => false,
            }
        }
        _ => false,
    }
}
