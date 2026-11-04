//! The fleet views against goldens the TypeScript CLI's own functions printed (`bun scripts/cli-goldens.ts`).

use scp_cli::fleet::json::Json;
use scp_cli::fleet::mounts::hook_client;
use scp_cli::fleet::view;

fn fixture() -> Json {
    Json::parse(include_bytes!("fixtures/fleet.json")).expect("fleet.json")
}

fn strings(value: &Json) -> Vec<String> {
    value
        .items()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

fn get<'a>(value: &'a Json, key: &str) -> &'a Json {
    value.get(key).unwrap_or_else(|| panic!("no {key}"))
}

#[test]
fn tables_pad_by_utf16_units_and_trim_as_javascript_does() {
    for case in get(&fixture(), "tables").items() {
        let rows: Vec<Vec<String>> = get(case, "rows").items().iter().map(strings).collect();
        assert_eq!(view::table(&rows), strings(get(case, "lines")), "{rows:?}");
    }
}

#[test]
fn list_and_tree_print_as_the_typescript_cli_does() {
    for case in get(&fixture(), "views").items() {
        let fleet = get(case, "fleet");
        let me = get(case, "me").to_value();
        let all: Vec<&Json> = fleet.items().iter().collect();
        assert_eq!(
            view::endpoints(&all, &me, "laptop", "/home/u"),
            strings(get(case, "endpoints")),
            "endpoints, me {me}"
        );
        assert_eq!(
            view::tree(&all, &me, "/home/u"),
            strings(get(case, "tree")),
            "tree, me {me}"
        );
        let (shown, hidden, historic) = view::unlisted(fleet.items(), false);
        let expected = get(case, "unlisted");
        let shown: Vec<String> = shown.iter().map(|e| view::text(e.get("address"))).collect();
        assert_eq!(shown, strings(get(expected, "shown")));
        assert_eq!(hidden as f64, get(expected, "hidden").as_f64().unwrap());
        assert_eq!(historic as f64, get(expected, "historic").as_f64().unwrap());
        let mut folded: Vec<String> = view::unspawned(fleet.items(), &me).into_iter().collect();
        folded.sort_by(|a, b| view::utf16_cmp(a, b));
        assert_eq!(folded, strings(get(case, "unspawned")));
    }
}

#[test]
fn the_status_summary_prints_as_the_typescript_cli_does() {
    for case in get(&fixture(), "summaries").items() {
        let me = get(case, "me").to_value();
        let all = get(case, "all") == &Json::Bool(true);
        let (lines, quotes) = view::summary(get(case, "snapshot"), &me, all);
        assert_eq!(lines, strings(get(case, "lines")), "me {me}");
        assert_eq!(Json::Bool(quotes), *get(case, "quotes"), "me {me}");
    }
}

#[test]
fn fleet_events_read_as_the_typescript_cli_writes_them() {
    for case in get(&fixture(), "events").items() {
        assert_eq!(
            view::fleet_line(get(case, "event")),
            get(case, "line").as_str().unwrap()
        );
    }
}

#[test]
fn addresses_sort_as_locale_compare_does() {
    let expected = strings(get(&fixture(), "sorted"));
    let mut words = expected.clone();
    words.reverse();
    words.sort_by(|a, b| view::locale_cmp(a, b));
    assert_eq!(words, expected);
}

#[test]
fn hook_clients_are_found_as_the_typescript_cli_finds_them() {
    for case in get(&fixture(), "hooks").items() {
        let expected = match get(case, "client") {
            Json::Null => None,
            client => Some((
                get(client, "bin").as_str().unwrap().to_owned(),
                get(client, "guarded") == &Json::Bool(true),
            )),
        };
        assert_eq!(hook_client(get(case, "command")), expected, "{case:?}");
    }
}
