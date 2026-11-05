//! `holds`: the judge's held messages, reviewed by the human at a terminal (the broker refuses anyone else).

use super::shorthand;
use super::text::{hold_lines, hold_rows};
use crate::args::Parsed;
use crate::fleet::view::{table, text};
use crate::fleet::{ask, iterating, length};
use crate::open::{Opened, with_opened};
use crate::term::{note, out};
use crate::{Call, Done, Fail, usage};
use scp_core::protocol::CLI_NAME;
use scp_mcp::LocalFuture;
use scp_mcp::render::delivery_text;
use scp_mcp::tools::{js_trim, redacted_text};
use serde_json::Value;

/// what `holds` does
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Ls,
    Show,
    Release,
    Refuse,
}

/// the action and hold id, checked before any connection
pub fn holds_args(parsed: &Parsed) -> Result<(Action, Option<String>), Fail> {
    let words = &parsed.positionals;
    let action = words.first().map_or("ls", String::as_str);
    let id = words.get(1).cloned();
    let action = match action {
        "ls" => Some(Action::Ls),
        "show" => Some(Action::Show),
        "release" => Some(Action::Release),
        "refuse" => Some(Action::Refuse),
        _ => None,
    };
    let Some(action) = action.filter(|a| words.len() <= 2 && (*a == Action::Ls) != id.is_some())
    else {
        return Err(usage(format!(
            "{CLI_NAME} holds takes ls [--all], show <id>, release <id> [--redacted] or refuse <id> --reason TEXT"
        )));
    };
    if parsed.on("redacted") && action != Action::Release {
        return Err(usage(format!(
            "--redacted goes only with {CLI_NAME} holds release"
        )));
    }
    if parsed.has("reason") && action != Action::Refuse {
        return Err(usage(format!(
            "--reason goes only with {CLI_NAME} holds refuse"
        )));
    }
    if parsed.on("all") && action != Action::Ls {
        return Err(usage(format!("--all goes only with {CLI_NAME} holds ls")));
    }
    if action == Action::Refuse && parsed.text("reason").is_none_or(|r| js_trim(r).is_empty()) {
        return Err(usage(format!(
            "{CLI_NAME} holds refuse needs --reason TEXT: the sender is told it"
        )));
    }
    Ok((action, id))
}

pub fn holds(call: &Call) -> Done {
    holds_args(&call.parsed)?;
    with_opened(call, run)
}

fn run<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        opened.local(call.verb)?;
        let flags = &call.parsed;
        let (action, id) = holds_args(flags)?;
        let json = flags.on("json");
        let name = id.clone().unwrap_or_default();
        let id = Value::from(id);
        let shown = |result: &crate::fleet::json::Json| out(&result.pretty());
        match action {
            Action::Ls => {
                let params = if flags.on("all") {
                    vec![]
                } else {
                    vec![("state", Value::from("held"))]
                };
                let reply = ask(opened, "holds", params).await?;
                let holds = reply.get("holds");
                if json {
                    out(&shorthand("holds", holds));
                } else if length(holds)? == 0 {
                    note(if flags.on("all") {
                        "no held messages"
                    } else {
                        "no messages wait for review (--all lists resolved ones)"
                    });
                } else {
                    for line in table(&hold_rows(&iterating(holds, "holds")?)) {
                        out(&line);
                    }
                }
            }
            Action::Show => {
                let hold = ask(opened, "hold_show", vec![("id", id)]).await?;
                if json {
                    shown(&hold);
                } else {
                    for line in hold_lines(&hold) {
                        out(&line);
                    }
                }
            }
            Action::Release => {
                let mut params = vec![("id", id.clone())];
                if flags.on("redacted") {
                    params.push(("redacted", Value::Bool(true)));
                }
                let result = ask(opened, "hold_release", params).await?;
                if json {
                    shown(&result);
                } else {
                    let value = result.to_value();
                    let deliveries = iterating(result.get("deliveries"), "result.deliveries")?
                        .iter()
                        .map(|d| delivery_text(&d.to_value()))
                        .collect::<Vec<_>>()
                        .join(", ");
                    out(&format!(
                        "released {}: sent {} to {deliveries}{}",
                        name,
                        text(result.get("id")),
                        redacted_text(value.get("redacted"))
                    ));
                }
            }
            Action::Refuse => {
                let reason = Value::from(flags.text("reason").unwrap_or_default());
                let result = ask(
                    opened,
                    "hold_refuse",
                    vec![("id", id.clone()), ("reason", reason)],
                )
                .await?;
                if json {
                    shown(&result);
                } else {
                    out(&format!("refused {name}"));
                }
            }
        }
        Ok(0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::parse_verb;

    fn checked(words: &[&str]) -> Result<(Action, Option<String>), String> {
        let words: Vec<String> = words.iter().map(|w| w.to_string()).collect();
        holds_args(&parse_verb("holds", &words).unwrap()).map_err(|fail| match fail {
            Fail::Usage(message) => message,
            other => panic!("{other:?}"),
        })
    }

    #[test]
    fn holds_words_are_checked_in_the_typescript_order() {
        assert_eq!(checked(&[]), Ok((Action::Ls, None)));
        assert_eq!(
            checked(&["show", "h1"]),
            Ok((Action::Show, Some("h1".into())))
        );
        let words = "swarm holds takes ls [--all], show <id>, release <id> [--redacted] or refuse <id> --reason TEXT";
        for bad in [
            &["ls", "h1"][..],
            &["show"],
            &["nope", "h1"],
            &["show", "a", "b"],
        ] {
            assert_eq!(checked(bad).unwrap_err(), words, "{bad:?}");
        }
        assert_eq!(
            checked(&["show", "h", "--redacted", "--reason", "x"]).unwrap_err(),
            "--redacted goes only with swarm holds release"
        );
        assert_eq!(
            checked(&["release", "h", "--reason", "x", "--all"]).unwrap_err(),
            "--reason goes only with swarm holds refuse"
        );
        assert_eq!(
            checked(&["release", "h", "--all"]).unwrap_err(),
            "--all goes only with swarm holds ls"
        );
        assert_eq!(
            checked(&["refuse", "h", "--reason", " \n"]).unwrap_err(),
            "swarm holds refuse needs --reason TEXT: the sender is told it"
        );
        assert_eq!(
            checked(&["refuse", "h", "--reason", "spam"]),
            Ok((Action::Refuse, Some("h".into())))
        );
    }
}
