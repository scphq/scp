//! `rules`, `group` and `admin`: an endpoint's scope, the named groups, and who administers a tree or a group.

use super::text::{admin_line, group_text, scope_lines};
use crate::args::Parsed;
use crate::fleet::{ask, iterating, length};
use crate::open::Opened;
use crate::spawn::grant::{preset, selector_list};
use crate::term::{note, out};
use crate::{Call, Done, Fail, usage};
use scp_core::protocol::CLI_NAME;
use scp_mcp::LocalFuture;
use scp_mcp::render::widen_text;
use serde_json::{Map, Value};

pub type Params = Vec<(&'static str, Value)>;

/// the request a `rules` command sends
#[derive(Debug, PartialEq)]
pub enum RulesCall {
    /// a request answered with the endpoint's scope view
    View(&'static str, Params),
    /// `rules_widen`, for the endpoint named
    Widen(Params, String),
}

fn nonempty(word: Option<&String>) -> Option<&str> {
    word.map(String::as_str).filter(|w| !w.is_empty())
}

fn list(items: Vec<String>) -> Value {
    Value::from(items)
}

/// what `rules` asks for, checked as `rulesCommand` checks it
pub fn rules_call(parsed: &Parsed) -> Result<RulesCall, Fail> {
    let words = &parsed.positionals;
    let action = words.first().map_or("show", String::as_str);
    let endpoint = nonempty(words.get(1));
    let only = |allowed: &[&str]| {
        for key in ["in", "out", "scope", "allow"] {
            if parsed.has(key) && !allowed.contains(&key) {
                return Err(usage(format!(
                    "{CLI_NAME} rules {action} does not take --{key}"
                )));
            }
        }
        Ok(())
    };
    let sides = |params: &mut Params| {
        if let Some(incoming) = selector_list(parsed, "in") {
            params.push(("in", list(incoming)));
        }
        if let Some(outgoing) = selector_list(parsed, "out") {
            params.push(("out", list(outgoing)));
        }
    };
    let mut params: Params = Vec::new();
    match action {
        "show" => {
            only(&[])?;
            if words.len() <= 2 {
                if let Some(endpoint) = endpoint {
                    params.push(("endpoint", Value::from(endpoint)));
                }
                return Ok(RulesCall::View("rules", params));
            }
        }
        "set" if words.len() <= 2 => {
            if let Some(endpoint) = endpoint {
                params.push(("endpoint", Value::from(endpoint)));
            }
            sides(&mut params);
            if let Some(scope) = preset(parsed)? {
                params.push(("scope", Value::from(scope)));
            }
            if let Some(allow) = selector_list(parsed, "allow") {
                params.push(("allow", list(allow)));
            }
            if params.iter().all(|(key, _)| *key == "endpoint") {
                return Err(usage(format!(
                    "{CLI_NAME} rules set takes --in, --out, --scope or --allow"
                )));
            }
            return Ok(RulesCall::View("rules_set", params));
        }
        "widen" => {
            only(&["in", "out"])?;
            if let Some(endpoint) = endpoint.filter(|_| words.len() <= 2) {
                params.push(("endpoint", Value::from(endpoint)));
                sides(&mut params);
                if params.len() == 1 {
                    return Err(usage(format!("{CLI_NAME} rules widen takes --in or --out")));
                }
                return Ok(RulesCall::Widen(params, endpoint.to_owned()));
            }
        }
        "lift" => {
            only(&[])?;
            if let (Some(endpoint), Some(cap)) = (endpoint, nonempty(words.get(2)))
                && words.len() <= 3
            {
                params.push(("endpoint", Value::from(endpoint)));
                params.push(("cap", Value::from(cap)));
                return Ok(RulesCall::View("rules_lift", params));
            }
        }
        _ => {}
    }
    Err(usage(format!(
        "{CLI_NAME} rules takes show [endpoint], set [endpoint] --in/--out/--scope/--allow, widen <endpoint> --in/--out, or lift <endpoint> <cap>"
    )))
}

pub fn rules<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let json = call.parsed.on("json");
        match rules_call(&call.parsed)? {
            RulesCall::View(method, params) => {
                let view = ask(opened, method, params).await?;
                if json {
                    out(&view.pretty());
                } else {
                    for line in scope_lines(&view) {
                        out(&line);
                    }
                }
            }
            RulesCall::Widen(params, endpoint) => {
                let change = ask(opened, "rules_widen", params).await?;
                if json {
                    out(&change.pretty());
                } else {
                    for line in widen_text(&change.to_value(), &endpoint) {
                        out(&line);
                    }
                }
            }
        }
        Ok(0)
    })
}

/// a `group` word's action: a name the table lists, or one every JavaScript object inherits, which the request then carries as
/// `JSON.stringify` writes a function (left out) or `Object.prototype` (`{}`)
fn group_action(word: &str) -> Option<Option<Value>> {
    const INHERITED: [&str; 11] = [
        "constructor",
        "__defineGetter__",
        "__defineSetter__",
        "hasOwnProperty",
        "__lookupGetter__",
        "__lookupSetter__",
        "isPrototypeOf",
        "propertyIsEnumerable",
        "toString",
        "valueOf",
        "toLocaleString",
    ];
    Some(match word {
        "create" | "add" | "rules" | "ls" | "show" | "drop" | "pin" | "unpin" => {
            Some(Value::from(word))
        }
        "rm" => Some(Value::from("remove")),
        "__proto__" => Some(Value::Object(Map::new())),
        _ if INHERITED.contains(&word) => None,
        _ => return None,
    })
}

/// what `group` asks for, checked as `groupCommand` checks it
pub fn group_call(parsed: &Parsed) -> Result<Params, Fail> {
    let words = &parsed.positionals;
    let verb = words.first().map_or("", String::as_str);
    let name = nonempty(words.get(1));
    let endpoint = nonempty(words.get(2));
    let usage_text = format!(
        "{CLI_NAME} group takes create <name> [--rules S|--in S --out S], add|rm <name> <endpoint>, rules <name> --rules S|--in S|--out S, ls, show|drop|pin|unpin <name>"
    );
    let Some(action) = (!verb.is_empty()).then(|| group_action(verb)).flatten() else {
        return Err(usage(usage_text));
    };
    let is = |word: &str| action.as_ref().and_then(Value::as_str) == Some(word);
    let needs_endpoint = is("add") || is("remove");
    let ruled = is("create") || is("rules");
    if is("ls") != name.is_none() || needs_endpoint != endpoint.is_some() || words.len() > 3 {
        return Err(usage(usage_text));
    }
    if !ruled && (parsed.has("rules") || parsed.has("in") || parsed.has("out")) {
        return Err(usage(format!("{CLI_NAME} group {verb} takes no rules")));
    }
    let mut params: Params = Vec::new();
    if let Some(action) = &action {
        params.push(("action", action.clone()));
    }
    if let Some(name) = name {
        params.push(("name", Value::from(name)));
    }
    if let Some(endpoint) = endpoint {
        params.push(("endpoint", Value::from(endpoint)));
    }
    let mut ruling = false;
    for key in ["rules", "in", "out"] {
        if let Some(selectors) = selector_list(parsed, key) {
            params.push((key, list(selectors)));
            ruling = true;
        }
    }
    if is("rules") && !ruling {
        return Err(usage(format!(
            "{CLI_NAME} group rules takes --rules, --in or --out"
        )));
    }
    Ok(params)
}

pub fn group<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let params = group_call(&call.parsed)?;
        let result = ask(opened, "group", params).await?;
        if call.parsed.on("json") {
            out(&result.pretty());
        } else {
            out(&group_text(&result));
        }
        Ok(0)
    })
}

/// an `admin` grant or revoke: the action, the subject and what it is over
#[derive(Debug, PartialEq)]
pub struct Change {
    pub action: String,
    pub subject: String,
    /// `tree` or `group`, and its name
    pub over: (&'static str, String),
}

/// what `admin` asks for: None for `ls`, else the change, checked as the CLI checks it
pub fn admin_call(parsed: &Parsed) -> Result<Option<Change>, Fail> {
    let words = &parsed.positionals;
    let action = words.first().map(String::as_str);
    let subject = nonempty(words.get(1));
    if action == Some("ls") && subject.is_none() {
        return Ok(None);
    }
    let (Some(action @ ("grant" | "revoke")), Some(subject), true) =
        (action, subject, words.len() <= 2)
    else {
        return Err(usage(format!(
            "{CLI_NAME} admin takes grant|revoke <endpoint> --tree <root>|--group <name>, or ls"
        )));
    };
    let given = |key: &str| parsed.text(key).filter(|v| !v.is_empty());
    let over = match (given("tree"), given("group")) {
        (Some(tree), None) => ("tree", tree),
        (None, Some(group)) => ("group", group),
        _ => {
            return Err(usage(format!(
                "{CLI_NAME} admin {action} takes one of --tree <root> or --group <name>"
            )));
        }
    };
    Ok(Some(Change {
        action: action.to_owned(),
        subject: subject.to_owned(),
        over: (over.0, over.1.to_owned()),
    }))
}

pub fn admin<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let json = call.parsed.on("json");
        let Some(change) = admin_call(&call.parsed)? else {
            let result = ask(opened, "admin", vec![("action", Value::from("ls"))]).await?;
            if json {
                out(&result.pretty());
            } else if length(Some(&result))? == 0 {
                note("no admins");
            } else {
                for row in iterating(Some(&result), "result")? {
                    out(&admin_line(&row));
                }
            }
            return Ok(0);
        };
        let (kind, over) = &change.over;
        let result = ask(
            opened,
            "admin",
            vec![
                ("action", Value::from(change.action.as_str())),
                ("subject", Value::from(change.subject.as_str())),
                (*kind, Value::from(over.as_str())),
            ],
        )
        .await?;
        if json {
            out(&result.pretty());
        } else {
            let done = if change.action == "grant" {
                "granted"
            } else {
                "revoked"
            };
            out(&format!(
                "{}: admin {done} over {kind} {over}",
                change.subject
            ));
        }
        Ok(0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::parse_verb;

    fn parsed(verb: &str, words: &[&str]) -> Parsed {
        let words: Vec<String> = words.iter().map(|w| w.to_string()).collect();
        parse_verb(verb, &words).unwrap()
    }

    fn refused<T: std::fmt::Debug>(result: Result<T, Fail>) -> String {
        match result.unwrap_err() {
            Fail::Usage(message) => message,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn rules_checks_its_flags_per_action_before_its_words() {
        assert_eq!(
            rules_call(&parsed("rules", &[])),
            Ok(RulesCall::View("rules", vec![]))
        );
        assert_eq!(
            rules_call(&parsed("rules", &["show", ""])),
            Ok(RulesCall::View("rules", vec![]))
        );
        assert_eq!(
            refused(rules_call(&parsed(
                "rules",
                &["show", "a", "b", "--in", "x"]
            ))),
            "swarm rules show does not take --in"
        );
        assert_eq!(
            refused(rules_call(&parsed("rules", &["lift", "--scope", "tree"]))),
            "swarm rules lift does not take --scope"
        );
        assert!(
            refused(rules_call(&parsed("rules", &["show", "a", "b"])))
                .starts_with("swarm rules takes show")
        );
        assert!(refused(rules_call(&parsed("rules", &[""]))).starts_with("swarm rules takes show"));
        assert_eq!(
            refused(rules_call(&parsed("rules", &["set", "--scope", "x"]))),
            "--scope takes open, tree, parent or none"
        );
        assert_eq!(
            refused(rules_call(&parsed("rules", &["set", "me/a"]))),
            "swarm rules set takes --in, --out, --scope or --allow"
        );
        assert_eq!(
            rules_call(&parsed(
                "rules",
                &["set", "--in", ",", "--allow", "a,b", "--allow", "c"]
            )),
            Ok(RulesCall::View(
                "rules_set",
                vec![
                    ("in", Value::from(Vec::<String>::new())),
                    ("allow", Value::from(vec!["a", "b", "c"]))
                ]
            ))
        );
        assert_eq!(
            refused(rules_call(&parsed("rules", &["widen", "me/a"]))),
            "swarm rules widen takes --in or --out"
        );
        assert_eq!(
            rules_call(&parsed("rules", &["widen", "me/a", "--out", "me/b"])),
            Ok(RulesCall::Widen(
                vec![
                    ("endpoint", Value::from("me/a")),
                    ("out", Value::from(vec!["me/b"]))
                ],
                "me/a".into()
            ))
        );
        assert!(
            refused(rules_call(&parsed("rules", &["lift", "me/a"])))
                .starts_with("swarm rules takes")
        );
    }

    #[test]
    fn group_checks_its_words_then_its_rules() {
        assert_eq!(
            group_call(&parsed("group", &["ls"])),
            Ok(vec![("action", Value::from("ls"))])
        );
        assert!(
            refused(group_call(&parsed("group", &["ls", "g"]))).starts_with("swarm group takes")
        );
        assert!(
            refused(group_call(&parsed("group", &["add", "g"]))).starts_with("swarm group takes")
        );
        assert!(
            refused(group_call(&parsed("group", &["bogus", "g"]))).starts_with("swarm group takes")
        );
        assert_eq!(
            refused(group_call(&parsed("group", &["show", "g", "--in", "a"]))),
            "swarm group show takes no rules"
        );
        assert_eq!(
            refused(group_call(&parsed("group", &["rules", "g"]))),
            "swarm group rules takes --rules, --in or --out"
        );
        assert_eq!(
            group_call(&parsed("group", &["rm", "g", "me/a"])),
            Ok(vec![
                ("action", Value::from("remove")),
                ("name", Value::from("g")),
                ("endpoint", Value::from("me/a"))
            ])
        );
        assert_eq!(
            group_call(&parsed("group", &["toString", "g"])),
            Ok(vec![("name", Value::from("g"))])
        );
        assert_eq!(
            group_call(&parsed("group", &["__proto__", "g"])),
            Ok(vec![
                ("action", Value::Object(Map::new())),
                ("name", Value::from("g"))
            ])
        );
    }

    #[test]
    fn admin_takes_one_of_tree_or_group() {
        assert_eq!(admin_call(&parsed("admin", &["ls"])), Ok(None));
        assert!(
            refused(admin_call(&parsed("admin", &["ls", "x"]))).starts_with("swarm admin takes")
        );
        assert_eq!(
            refused(admin_call(&parsed(
                "admin",
                &["grant", "me/a", "--tree", ""]
            ))),
            "swarm admin grant takes one of --tree <root> or --group <name>"
        );
        assert_eq!(
            admin_call(&parsed(
                "admin",
                &["revoke", "me/a", "--tree", "", "--group", "g"]
            )),
            Ok(Some(Change {
                action: "revoke".into(),
                subject: "me/a".into(),
                over: ("group", "g".into())
            }))
        );
    }
}
