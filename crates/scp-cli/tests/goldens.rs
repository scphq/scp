//! The native argument parsing against goldens the TypeScript CLI wrote under Node (`bun scripts/cli-goldens.ts`).

use scp_cli::args::{hoist_identity, parse_verb};
use serde_json::Value;

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn parsing_matches_node_parse_args() {
    let rows: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/parse.json")).expect("parse.json");
    assert!(rows.len() > 40);
    for row in rows {
        let argv = strings(&row["argv"]);
        let hoisted = hoist_identity(&argv);
        let (verb, rest) = hoisted
            .split_first()
            .map_or(("", &[][..]), |(v, r)| (v.as_str(), r));
        assert_eq!(verb, row["verb"].as_str().unwrap(), "{argv:?}");
        if row.get("unknown").is_some() {
            assert_eq!(rest, strings(&row["rest"]).as_slice(), "{argv:?}");
            continue;
        }
        match (parse_verb(verb, rest), row.get("error")) {
            (Err(message), Some(expected)) => {
                assert_eq!(message, expected.as_str().unwrap(), "{argv:?}")
            }
            (Ok(parsed), None) => {
                let values: Vec<Value> = parsed
                    .values
                    .iter()
                    .map(|(k, v)| Value::from(vec![Value::from(k.as_str()), v.to_json()]))
                    .collect();
                assert_eq!(Value::from(values), row["values"], "{argv:?}");
                assert_eq!(parsed.positionals, strings(&row["positionals"]), "{argv:?}");
            }
            (got, _) => panic!("{argv:?}: got {got:?}, expected {row}"),
        }
    }
}
