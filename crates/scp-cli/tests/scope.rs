//! Scopes, groups and holds against goldens the TypeScript CLI's own functions wrote (`bun scripts/cli-goldens.ts`).

use scp_cli::Fail;
use scp_cli::args::{Parsed, Val};
use scp_cli::fleet::json::Json;
use scp_cli::scope::holds::{Action, holds_args};
use scp_cli::scope::text::{group_text, scope_lines};

fn fixture() -> Json {
    Json::parse(include_bytes!("fixtures/scope.json")).expect("scope.json")
}

fn get<'a>(value: &'a Json, key: &str) -> &'a Json {
    value.get(key).unwrap_or_else(|| panic!("no {key}"))
}

fn strings(value: &Json) -> Vec<String> {
    value
        .items()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn a_scope_prints_as_the_typescript_cli_prints_it() {
    for case in get(&fixture(), "views").items() {
        assert_eq!(
            scope_lines(get(case, "view")),
            strings(get(case, "lines")),
            "{case:?}"
        );
    }
}

#[test]
fn group_results_read_as_group_text_writes_them() {
    for case in get(&fixture(), "groups").items() {
        assert_eq!(
            group_text(get(case, "result")),
            get(case, "text").as_str().unwrap(),
            "{case:?}"
        );
    }
}

#[test]
fn holds_words_are_checked_as_holds_args_checks_them() {
    for case in get(&fixture(), "holds").items() {
        let values = get(case, "values")
            .entries()
            .into_iter()
            .map(|(key, value)| {
                let value = match value {
                    Json::Bool(on) => Val::Flag(*on),
                    other => Val::Text(other.as_str().unwrap().to_owned()),
                };
                (key.to_owned(), value)
            })
            .collect();
        let parsed = Parsed {
            values,
            positionals: strings(get(case, "words")),
        };
        match (holds_args(&parsed), case.get("error")) {
            (Err(Fail::Usage(message)), Some(expected)) => {
                assert_eq!(message, expected.as_str().unwrap(), "{case:?}")
            }
            (Ok((action, id)), None) => {
                let args = get(case, "args");
                let word = match action {
                    Action::Ls => "ls",
                    Action::Show => "show",
                    Action::Release => "release",
                    Action::Refuse => "refuse",
                };
                assert_eq!(Some(word), get(args, "action").as_str(), "{case:?}");
                assert_eq!(
                    id.as_deref(),
                    args.get("id").and_then(Json::as_str),
                    "{case:?}"
                );
            }
            (got, _) => panic!("{case:?}: got {got:?}"),
        }
    }
}
