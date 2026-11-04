//! The command line as the TypeScript CLI reads it: identity flags hoisted past the verb, then Node's `util.parseArgs` in strict mode.

use serde_json::{Map, Value};
use std::sync::OnceLock;

/// what a flag holds once parsed
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Val {
    Flag(bool),
    Text(String),
    List(Vec<String>),
}

impl Val {
    pub fn to_json(&self) -> Value {
        match self {
            Val::Flag(on) => Value::Bool(*on),
            Val::Text(text) => Value::String(text.clone()),
            Val::List(items) => Value::from(items.clone()),
        }
    }
}

/// flags in the order they were first given, and the positionals
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Parsed {
    pub values: Vec<(String, Val)>,
    pub positionals: Vec<String>,
}

impl Parsed {
    pub fn get(&self, key: &str) -> Option<&Val> {
        self.values.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// a string flag's value
    pub fn text(&self, key: &str) -> Option<&str> {
        match self.get(key) {
            Some(Val::Text(text)) => Some(text),
            _ => None,
        }
    }

    /// whether a boolean flag is set
    pub fn on(&self, key: &str) -> bool {
        matches!(self.get(key), Some(Val::Flag(true)))
    }

    pub fn list(&self, key: &str) -> &[String] {
        match self.get(key) {
            Some(Val::List(items)) => items,
            _ => &[],
        }
    }

    pub fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
}

/// one option as `parseArgs` takes it
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opt {
    pub string: bool,
    pub short: Option<String>,
    pub multiple: bool,
}

pub type Options = Vec<(String, Opt)>;

/// the TypeScript CLI's option tables: every option, per-verb overrides and each verb's allowed flags
pub struct Tables {
    pub options: Options,
    verb_options: Map<String, Value>,
    verbs: Map<String, Value>,
}

const TABLES: &str = include_str!("options.json");

fn options_of(value: &Value) -> Options {
    value
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(name, spec)| {
                    (
                        name.clone(),
                        Opt {
                            string: spec.get("type").and_then(Value::as_str) == Some("string"),
                            short: spec.get("short").and_then(Value::as_str).map(str::to_owned),
                            multiple: spec.get("multiple").and_then(Value::as_bool) == Some(true),
                        },
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn tables() -> &'static Tables {
    static TABLES_CELL: OnceLock<Tables> = OnceLock::new();
    TABLES_CELL.get_or_init(|| {
        let value: Value = serde_json::from_str(TABLES).unwrap_or_default();
        let object = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default()
        };
        Tables {
            options: options_of(value.get("options").unwrap_or(&Value::Null)),
            verb_options: object("verb_options"),
            verbs: object("verbs"),
        }
    })
}

impl Tables {
    /// the options `verb` parses under: every option with the verb's overrides
    pub fn for_verb(&self, verb: &str) -> Options {
        let mut options = self.options.clone();
        for (name, opt) in options_of(self.verb_options.get(verb).unwrap_or(&Value::Null)) {
            match options.iter_mut().find(|(n, _)| *n == name) {
                Some(slot) => slot.1 = opt,
                None => options.push((name, opt)),
            }
        }
        options
    }

    /// the flags `verb` takes, or None for a verb that does not parse its words this way
    pub fn allowed(&self, verb: &str) -> Option<Vec<&str>> {
        Some(
            self.verbs
                .get(verb)?
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .collect(),
        )
    }
}

/// `--as X`, `--as=X` and `--human` before the verb, moved after it
pub fn hoist_identity(argv: &[String]) -> Vec<String> {
    let mut i = 0;
    while i < argv.len() {
        if argv[i] == "--as" && i + 1 < argv.len() {
            i += 2;
        } else if argv[i].starts_with("--as=") || argv[i] == "--human" {
            i += 1;
        } else {
            break;
        }
    }
    if i > 0 && i < argv.len() {
        let mut out = vec![argv[i].clone()];
        out.extend_from_slice(&argv[..i]);
        out.extend_from_slice(&argv[i + 1..]);
        out
    } else {
        argv.to_vec()
    }
}

type Units = Vec<u16>;

fn units(text: &str) -> Units {
    text.encode_utf16().collect()
}

fn text(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

const DASH: u16 = b'-' as u16;
const EQUALS: u16 = b'=' as u16;

#[derive(Debug)]
enum Token {
    Option {
        name: String,
        raw: String,
        value: Option<String>,
        inline: bool,
    },
    Positional(String),
}

fn long_for_short(short: &[u16], options: &Options) -> String {
    let short = text(short);
    options
        .iter()
        .find(|(_, opt)| opt.short.as_deref() == Some(short.as_str()))
        .map(|(name, _)| name.clone())
        .unwrap_or(short)
}

fn is_string(name: &str, options: &Options) -> bool {
    options.iter().any(|(n, opt)| n == name && opt.string)
}

fn contains_from(arg: &[u16], unit: u16, from: usize) -> bool {
    arg.iter().skip(from).any(|&u| u == unit)
}

fn tokens(args: &[String], options: &Options) -> Vec<Token> {
    let mut out = Vec::new();
    let mut remaining: std::collections::VecDeque<Units> = args.iter().map(|a| units(a)).collect();
    while let Some(arg) = remaining.pop_front() {
        let next_is_value = remaining.front().is_some();
        if arg == [DASH, DASH] {
            out.extend(remaining.drain(..).map(|a| Token::Positional(text(&a))));
            break;
        }
        let short_start = arg.len() >= 2 && arg[0] == DASH && arg[1] != DASH;
        if arg.len() == 2 && short_start {
            let name = long_for_short(&arg[1..2], options);
            let value = if is_string(&name, options) && next_is_value {
                remaining.pop_front().map(|v| text(&v))
            } else {
                None
            };
            out.push(Token::Option {
                name,
                raw: text(&arg),
                inline: false,
                value,
            });
            continue;
        }
        if arg.len() > 2 && short_start {
            let first = long_for_short(&arg[1..2], options);
            if !is_string(&first, options) {
                let mut expanded = Vec::new();
                for at in 1..arg.len() {
                    let name = long_for_short(&arg[at..at + 1], options);
                    if !is_string(&name, options) || at == arg.len() - 1 {
                        expanded.push(vec![DASH, arg[at]]);
                    } else {
                        let mut rest = vec![DASH];
                        rest.extend_from_slice(&arg[at..]);
                        expanded.push(rest);
                        break;
                    }
                }
                for item in expanded.into_iter().rev() {
                    remaining.push_front(item);
                }
                continue;
            }
            let name = long_for_short(&arg[1..2], options);
            out.push(Token::Option {
                name,
                raw: text(&arg[..2]),
                value: Some(text(&arg[2..])),
                inline: true,
            });
            continue;
        }
        if arg.len() > 2 && arg[0] == DASH && arg[1] == DASH {
            if !contains_from(&arg, EQUALS, 3) {
                let name = text(&arg[2..]);
                let value = if is_string(&name, options) && next_is_value {
                    remaining.pop_front().map(|v| text(&v))
                } else {
                    None
                };
                out.push(Token::Option {
                    raw: text(&arg),
                    name,
                    inline: false,
                    value,
                });
            } else {
                let equals = arg.iter().position(|&u| u == EQUALS).unwrap_or(arg.len());
                let name = text(&arg[2..equals]);
                out.push(Token::Option {
                    raw: format!("--{name}"),
                    name,
                    value: Some(text(&arg[equals + 1..])),
                    inline: true,
                });
            }
            continue;
        }
        out.push(Token::Positional(text(&arg)));
    }
    out
}

/// a string as `JSON.stringify` writes it
pub fn js_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// `parseArgs({ args, options, allowPositionals: true, strict: true })`, failing with the message Node throws
pub fn parse(args: &[String], options: &Options) -> Result<Parsed, String> {
    let mut parsed = Parsed::default();
    for token in tokens(args, options) {
        let (name, raw, value, inline) = match token {
            Token::Positional(value) => {
                parsed.positionals.push(value);
                continue;
            }
            Token::Option {
                name,
                raw,
                value,
                inline,
            } => (name, raw, value, inline),
        };
        let Some(opt) = options.iter().find(|(n, _)| *n == name).map(|(_, o)| o) else {
            return Err(format!(
                "Unknown option '{raw}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- {}",
                js_string(&raw)
            ));
        };
        let both = match &opt.short {
            Some(short) => format!("-{short}, --{name}"),
            None => format!("--{name}"),
        };
        if opt.string && value.is_none() {
            return Err(format!("Option '{both} <value>' argument missing"));
        }
        if !opt.string && value.is_some() {
            return Err(format!("Option '{both}' does not take an argument"));
        }
        if let Some(value) = value.as_deref()
            && !inline
            && value.encode_utf16().count() > 1
            && value.starts_with('-')
        {
            let example = if raw.starts_with("--") {
                format!("'{raw}=-XYZ'")
            } else {
                format!("'--{name}=-XYZ' or '{raw}-XYZ'")
            };
            return Err(format!(
                "Option '{raw}' argument is ambiguous.\nDid you forget to specify the option argument for '{raw}'?\nTo specify an option argument starting with a dash use {example}."
            ));
        }
        if name == "__proto__" {
            continue;
        }
        let stored = match value {
            None => Val::Flag(true),
            Some(value) if opt.multiple => {
                if let Some((_, Val::List(items))) =
                    parsed.values.iter_mut().find(|(k, _)| *k == name)
                {
                    items.push(value);
                    continue;
                }
                Val::List(vec![value])
            }
            Some(value) => Val::Text(value),
        };
        match parsed.values.iter_mut().find(|(k, _)| *k == name) {
            Some(slot) => slot.1 = stored,
            None => parsed.values.push((name, stored)),
        }
    }
    Ok(parsed)
}

/// what the TypeScript CLI makes of `verb`'s words: parsed under its options, with a flag it does not take refused
pub fn parse_verb(verb: &str, rest: &[String]) -> Result<Parsed, String> {
    let tables = tables();
    let allowed = tables.allowed(verb).unwrap_or_default();
    let parsed = parse(rest, &tables.for_verb(verb))?;
    if parsed.has("help") {
        return Ok(parsed);
    }
    if let Some((key, _)) = parsed
        .values
        .iter()
        .find(|(key, _)| !allowed.contains(&key.as_str()))
    {
        return Err(format!(
            "{} {verb} does not take --{key}",
            scp_core::protocol::CLI_NAME
        ));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn identity_flags_before_the_verb_move_after_it() {
        assert_eq!(
            hoist_identity(&words(&["--as", "x", "--human", "whoami", "a"])),
            words(&["whoami", "--as", "x", "--human", "a"])
        );
        assert_eq!(
            hoist_identity(&words(&["--as", "x"])),
            words(&["--as", "x"])
        );
        assert_eq!(hoist_identity(&words(&["whoami"])), words(&["whoami"]));
    }

    #[test]
    fn a_string_option_in_a_group_takes_the_rest() {
        let options = vec![
            (
                "all".to_owned(),
                Opt {
                    string: false,
                    short: Some("a".into()),
                    multiple: false,
                },
            ),
            (
                "file".to_owned(),
                Opt {
                    string: true,
                    short: Some("f".into()),
                    multiple: false,
                },
            ),
        ];
        let parsed = parse(&words(&["-afx.txt", "-fy"]), &options).unwrap();
        assert_eq!(
            parsed.values,
            vec![
                ("all".into(), Val::Flag(true)),
                ("file".into(), Val::Text("y".into()))
            ]
        );
    }
}
