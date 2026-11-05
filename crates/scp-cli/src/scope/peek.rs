//! `peek` and `set-peek`: another agent's last turns behind the preamble, who peeked, and the caller's own peek setting.

use super::shorthand;
use super::text::seen_line;
use crate::args::{Val, js_string};
use crate::fleet::json::Json;
use crate::fleet::view::text;
use crate::fleet::{ask, iterating, length};
use crate::open::Opened;
use crate::term::{note, out};
use crate::{Call, Done, Fail, usage};
use scp_core::protocol::CLI_NAME;
use scp_mcp::LocalFuture;
use scp_mcp::render::{PREAMBLE, wrap_peek};
use serde_json::Value;

const TURNS_MAX: u32 = 10;

/// `--turns`: a whole number from 1 to 10
pub fn turns_arg(value: Option<&Val>) -> Result<Option<u32>, Fail> {
    let Some(value) = value else {
        return Ok(None);
    };
    let turns = match value {
        Val::Text(text) if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) => {
            text.parse::<f64>().unwrap_or(f64::NAN)
        }
        _ => f64::NAN,
    };
    if (1.0..=f64::from(TURNS_MAX)).contains(&turns) {
        return Ok(Some(turns as u32));
    }
    let shown = match value {
        Val::Text(text) => js_string(text),
        other => other.to_json().to_string(),
    };
    Err(usage(format!(
        "--turns takes a whole number from 1 to {TURNS_MAX}, not {shown}"
    )))
}

pub fn peek<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let flags = &call.parsed;
        let json = flags.on("json");
        let words = &flags.positionals;
        if words.len() > 1 {
            return Err(usage(format!("{CLI_NAME} peek takes one address")));
        }
        let endpoint = words.first().map(String::as_str);
        if flags.on("who") {
            if flags.has("turns") || flags.has("full") {
                return Err(usage(format!(
                    "{CLI_NAME} peek --who takes no --turns or --full"
                )));
            }
            let params = match endpoint.filter(|e| !e.is_empty()) {
                Some(endpoint) => vec![("endpoint", Value::from(endpoint))],
                None => vec![],
            };
            let reply = ask(opened, "peek_who", params).await?;
            let seen = reply.get("peeked_by");
            if json {
                out(&shorthand("peeked_by", seen));
            } else if length(seen)? == 0 {
                note(&format!("nobody peeked at {}", endpoint.unwrap_or("you")));
            } else {
                for row in iterating(seen, "peeked_by")? {
                    out(&seen_line(&row));
                }
            }
            return Ok(0);
        }
        let Some(endpoint) = endpoint.filter(|e| !e.is_empty()) else {
            return Err(usage(format!("{CLI_NAME} peek takes an address, or --who")));
        };
        let turns = turns_arg(flags.get("turns"))?;
        let mut params = vec![("endpoint", Value::from(endpoint))];
        if let Some(turns) = turns {
            params.push(("turns", Value::from(turns)));
        }
        if flags.on("full") {
            params.push(("full", Value::Bool(true)));
        }
        let result = ask(opened, "peek", params).await?;
        if json {
            out(&Json::spread(vec![("preamble", Json::str(PREAMBLE))], &result, vec![]).pretty());
        } else {
            out(&format!("{PREAMBLE}\n\n{}", wrap_peek(&result.to_value())));
        }
        Ok(0)
    })
}

/// the level and endpoint of `set-peek on|off [endpoint]`
pub fn set_peek_args(words: &[String]) -> Result<(&str, Option<&str>), Fail> {
    match words {
        [level] | [level, _] if ["on", "local", "off"].contains(&level.as_str()) => Ok((
            level,
            words.get(1).map(String::as_str).filter(|e| !e.is_empty()),
        )),
        _ => Err(usage(format!(
            "{CLI_NAME} set-peek takes on|off [endpoint]"
        ))),
    }
}

pub fn set_peek<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let (level, endpoint) = set_peek_args(&call.parsed.positionals)?;
        let mut params = vec![("level", Value::from(level))];
        if let Some(endpoint) = endpoint {
            params.push(("endpoint", Value::from(endpoint)));
        }
        let result = ask(opened, "peek_set", params).await?;
        if call.parsed.on("json") {
            out(&result.pretty());
        } else {
            let peek = match result.get("peek") {
                None | Some(Json::Null) => "off".into(),
                some => text(some),
            };
            out(&format!("{}: peek {peek}", text(result.get("endpoint"))));
        }
        Ok(0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_are_a_whole_number_from_one_to_ten() {
        let turns = |text: &str| turns_arg(Some(&Val::Text(text.into())));
        assert_eq!(turns_arg(None), Ok(None));
        assert_eq!(turns("1"), Ok(Some(1)));
        assert_eq!(turns("010"), Ok(Some(10)));
        for bad in ["0", "11", "1.5", "", " 2", "1e1", "-1"] {
            assert_eq!(
                turns(bad),
                Err(usage(format!(
                    "--turns takes a whole number from 1 to 10, not {}",
                    js_string(bad)
                )))
            );
        }
    }

    #[test]
    fn set_peek_takes_a_level_and_maybe_an_endpoint() {
        let words = |list: &[&str]| list.iter().map(|w| w.to_string()).collect::<Vec<_>>();
        assert_eq!(set_peek_args(&words(&["on"])), Ok(("on", None)));
        assert_eq!(
            set_peek_args(&words(&["off", "me/a"])),
            Ok(("off", Some("me/a")))
        );
        assert_eq!(set_peek_args(&words(&["local", ""])), Ok(("local", None)));
        for bad in [&[][..], &["no"], &["on", "a", "b"], &[""]] {
            assert_eq!(
                set_peek_args(&words(bad)),
                Err(usage("swarm set-peek takes on|off [endpoint]"))
            );
        }
    }
}
