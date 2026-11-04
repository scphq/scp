//! `swarm relink`: the broker's relink of background sessions' names, and `--check`'s read-only report of mismatched endpoints.

use crate::claude::bg_state::{read_records, read_state, short_id};
use crate::fleet::json::Json;
use crate::fleet::view::{text, truthy};
use crate::fleet::{ask, missing, reading, thrown};
use crate::open::Opened;
use crate::term::out;
use crate::{Call, Done, Fail, usage};
use indexmap::IndexMap;
use scp_core::protocol::CLI_NAME;
use scp_mcp::LocalFuture;
use scp_mcp::ps::Env;
use serde_json::Value;

/// the lines `swarm relink` prints: each pair, the count, and how to confirm the pairs that take a name a live session still holds
pub fn relink_report(pairs: &[Json], dry_run: bool, live: bool) -> Vec<String> {
    let mut lines: Vec<String> = pairs
        .iter()
        .map(|pair| {
            let held = if truthy(pair.get("live")) {
                ", held by its idle origin"
            } else {
                ""
            };
            format!(
                "me/{} -> me/{} (by {}{held})",
                text(pair.get("from")),
                text(pair.get("to")),
                text(pair.get("by"))
            )
        })
        .collect();
    let done = if dry_run {
        pairs.len()
    } else {
        pairs.iter().filter(|p| p.get("retired").is_some()).count()
    };
    let held = pairs
        .iter()
        .filter(|p| {
            truthy(p.get("live"))
                && if dry_run {
                    !live
                } else {
                    p.get("retired").is_none()
                }
        })
        .count();
    if pairs.is_empty() {
        return vec!["nothing to relink".into()];
    }
    if done > 0 {
        let verb = if dry_run { "would relink" } else { "relinked" };
        let noun = if done == 1 { "session" } else { "sessions" };
        lines.push(format!("{verb} {done} {noun}"));
    }
    if held > 0 {
        let what = if held == 1 {
            "takes its name from a session that still holds it"
        } else {
            "take their names from sessions that still hold them"
        };
        lines.push(format!(
            "{held} {what}: confirm with {CLI_NAME} relink --live, which closes the origin's connections"
        ));
    }
    lines
}

/// a background session by short id, with the handle its config or state names
pub type BgSession = (String, Option<String>);

/// `session !== null && ids.some((id) => session.startsWith(id))`, throwing where JavaScript does
fn given(ids: &[String], session: Option<&Json>) -> Result<bool, Fail> {
    match session {
        Some(Json::Null) => Ok(false),
        Some(Json::Str(session)) => Ok(ids.iter().any(|id| session.starts_with(id.as_str()))),
        None => Err(thrown(
            "Cannot read properties of undefined (reading 'startsWith')".into(),
        )),
        Some(_) => Err(thrown("session.startsWith is not a function".into())),
    }
}

fn field<'j>(value: &'j Json, key: &str) -> Result<Option<&'j Json>, Fail> {
    match missing(Some(value), key) {
        Some(fail) => Err(fail),
        None => Ok(value.get(key)),
    }
}

fn js_slice(text: &str, end: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(end).collect::<Vec<_>>())
}

/// the lines `swarm relink --check` prints: each endpoint at a background session's name, or one a rehome moved off that name, that a
/// harness session holds which is none of the sessions given that name (a short id is its session's first 8 characters) nor a fork of one
pub fn mismatch_report(
    sessions: &[BgSession],
    agents: Option<&Json>,
    rehomes: &[Json],
) -> Result<Vec<String>, Fail> {
    let mut named: IndexMap<&str, Vec<String>> = IndexMap::new();
    for (id, handle) in sessions {
        if let Some(handle) = handle {
            named.entry(handle).or_default().push(id.clone());
        }
    }
    let agents = reading(agents, "agents", "map")?;
    let mut by_handle: Vec<(Option<&Json>, &Json)> = Vec::new();
    let mut by_ref: Vec<(Option<&Json>, &Json)> = Vec::new();
    for agent in agents {
        by_handle.push((field(agent, "handle")?, agent));
    }
    for agent in agents {
        by_ref.push((field(agent, "address")?, agent));
        by_ref.push((field(agent, "id")?, agent));
    }
    let lookup = |map: &[(Option<&Json>, &'_ Json)], key: Option<&Json>| -> Option<Json> {
        map.iter()
            .rev()
            .find(|(k, _)| *k == key)
            .map(|(_, agent)| (*agent).clone())
    };
    let mut lines: Vec<(Option<Json>, String)> = Vec::new();
    let mut check = |agent: &Json, name: &str| -> Result<(), Fail> {
        let ids = &named[name];
        let by = field(agent, "harness_session")?;
        let id = agent.get("id").cloned();
        if matches!(by, Some(Json::Null))
            || lines.iter().any(|(k, _)| *k == id)
            || given(ids, by)?
            || given(ids, field(agent, "harness_origin")?)?
        {
            return Ok(());
        }
        let was = if agent.get("handle").and_then(Json::as_str) == Some(name) {
            String::new()
        } else {
            format!(" (was me/{name})")
        };
        let by = js_slice(by.and_then(Json::as_str).unwrap_or_default(), 8);
        let line = format!(
            "{} {}{was}: bg {} but held by session {by}",
            text(agent.get("address")),
            text(id.as_ref()),
            ids.join(", ")
        );
        lines.push((id, line));
        Ok(())
    };
    let names: Vec<&str> = named.keys().copied().collect();
    for name in names {
        let key = Json::str(name);
        if let Some(agent) = lookup(&by_handle, Some(&key)) {
            check(&agent, name)?;
        }
    }
    for row in rehomes {
        let detail = field(row, "detail")?;
        let from = match missing(detail, "from") {
            Some(fail) => return Err(fail),
            None => detail.and_then(|d| d.get("from")),
        };
        let endpoint = field(row, "endpoint")?;
        let agent = match endpoint {
            Some(Json::Null) => None,
            endpoint => lookup(&by_ref, endpoint),
        };
        if let (Some(Json::Str(from)), Some(agent)) = (from, agent)
            && named.contains_key(from.as_str())
        {
            check(&agent, from)?;
        }
    }
    Ok(if lines.is_empty() {
        vec!["no mismatched endpoints".into()]
    } else {
        lines.into_iter().map(|(_, line)| line).collect()
    })
}

/// the names in `dir` as Node's `readdirSync` lists them: sorted by bytes
fn sorted_names(dir: &std::path::Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort_unstable();
    names
}

/// the background sessions' configs, then their states, each as its short id and handle
pub fn bg_sessions(env: &Env) -> Vec<BgSession> {
    let mut records: Vec<(String, Option<String>)> = read_records(env)
        .into_iter()
        .map(|(id, record)| (id, record.handle))
        .collect();
    records.sort_by(|a, b| a.0.cmp(&b.0));
    let states = sorted_names(&crate::claude::bg_state::bg_dir(env))
        .into_iter()
        .filter_map(|name| {
            let id = name.strip_suffix(".state.json")?.to_owned();
            if !short_id(&id) {
                return None;
            }
            let state = read_state(env, &id)?;
            let handle = state.handle().filter(|h| !h.is_empty()).map(str::to_owned);
            Some((id, handle))
        });
    records.extend(states);
    records
}

pub const PAGE: usize = 1000;

pub fn relink<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let flags = &call.parsed;
        if !flags.positionals.is_empty() {
            return Err(usage(format!(
                "{CLI_NAME} relink takes no arguments: {CLI_NAME} relink [--dry-run] [--live] [--check]"
            )));
        }
        let json = flags.on("json");
        if flags.on("check") {
            if flags.on("live") {
                return Err(usage(format!(
                    "{CLI_NAME} relink --check changes nothing: drop --live"
                )));
            }
            let sessions = bg_sessions(call.env);
            let reply = ask(opened, "agents", Vec::new()).await?;
            let mut rehomes = Vec::new();
            let mut since = Json::Num(0.0);
            loop {
                let page = ask(
                    opened,
                    "log",
                    vec![("since", since.to_value()), ("limit", Value::from(PAGE))],
                )
                .await?;
                let rows = reading(page.get("rows"), "rows", "filter")?;
                rehomes.extend(
                    rows.iter()
                        .filter(|row| row.get("event").and_then(Json::as_str) == Some("rehome"))
                        .cloned(),
                );
                if rows.len() < PAGE {
                    break;
                }
                since = rows
                    .last()
                    .and_then(|row| row.get("id"))
                    .cloned()
                    .unwrap_or(Json::Null);
            }
            let lines = mismatch_report(&sessions, reply.get("agents"), &rehomes)?;
            if json {
                let mismatched = lines
                    .iter()
                    .filter(|line| line.starts_with("me/"))
                    .map(|line| Json::str(line.as_str()))
                    .collect();
                out(&Json::object(vec![("mismatched", Json::Arr(mismatched))]).pretty());
            } else {
                out(&lines.join("\n"));
            }
            return Ok(0);
        }
        let dry_run = flags.on("dry-run");
        let live = flags.on("live");
        let mut params = Vec::new();
        if dry_run {
            params.push(("dry_run", Value::Bool(true)));
        }
        if live {
            params.push(("live", Value::Bool(true)));
        }
        let result = ask(opened, "relink", params).await?;
        if json {
            out(&result.pretty());
        } else {
            let pairs = reading(result.get("relinked"), "pairs", "map")?;
            out(&relink_report(pairs, dry_run, live).join("\n"));
        }
        Ok(0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(from: &str, to: &str, by: &str, live: bool, retired: Option<&str>) -> Json {
        let mut entries = vec![
            ("from", Json::str(from)),
            ("to", Json::str(to)),
            ("by", Json::str(by)),
        ];
        if live {
            entries.push(("live", Json::Bool(true)));
        }
        if let Some(retired) = retired {
            entries.push(("retired", Json::str(retired)));
        }
        Json::object(entries)
    }

    #[test]
    fn a_dry_run_asks_to_confirm_the_pairs_a_live_origin_still_holds() {
        let released = pair("claude-app", "lead", "session", false, None);
        let live = pair("claude-app-2", "orchestrator", "origin", true, None);
        assert_eq!(
            relink_report(&[released, live.clone()], true, false),
            vec![
                "me/claude-app -> me/lead (by session)",
                "me/claude-app-2 -> me/orchestrator (by origin, held by its idle origin)",
                "would relink 2 sessions",
                "1 takes its name from a session that still holds it: confirm with swarm relink --live, which closes the origin's connections",
            ]
        );
        assert_eq!(
            relink_report(&[live], true, true).last().unwrap(),
            "would relink 1 session"
        );
    }

    #[test]
    fn an_apply_without_live_reports_the_live_pairs_it_left() {
        let released = pair("claude-app", "lead", "session", false, Some("ep_a"));
        let live = pair("claude-app-2", "orchestrator", "origin", true, None);
        assert_eq!(
            relink_report(&[released, live], false, false)[2..],
            [
                "relinked 1 session",
                "1 takes its name from a session that still holds it: confirm with swarm relink --live, which closes the origin's connections",
            ]
        );
        let retired = pair("claude-app-2", "orchestrator", "origin", true, Some("ep_b"));
        assert_eq!(
            relink_report(&[retired], false, true)[1..],
            ["relinked 1 session"]
        );
        assert_eq!(relink_report(&[], false, false), ["nothing to relink"]);
        let held = pair("a", "b", "origin", true, None);
        assert_eq!(
            relink_report(&[held.clone(), held], true, false)[3],
            "2 take their names from sessions that still hold them: confirm with swarm relink --live, which closes the origin's connections"
        );
    }

    const S: &str = "11111111-aaaa-4bbb-8ccc-000000000001";
    const X: &str = "22222222-aaaa-4bbb-8ccc-000000000002";
    const F: &str = "33333333-aaaa-4bbb-8ccc-000000000003";
    const R: &str = "44444444-aaaa-4bbb-8ccc-000000000004";

    fn agent(id: &str, handle: &str, session: Option<&str>, origin: Option<&str>) -> Json {
        let or_null = |v: Option<&str>| v.map_or(Json::Null, Json::str);
        Json::object(vec![
            ("id", Json::str(id)),
            ("address", Json::str(format!("me/{handle}"))),
            ("handle", Json::str(handle)),
            ("harness_session", or_null(session)),
            ("harness_origin", or_null(origin)),
        ])
    }

    fn sessions(list: &[(&str, Option<&str>)]) -> Vec<BgSession> {
        list.iter()
            .map(|(id, handle)| (id.to_string(), handle.map(str::to_owned)))
            .collect()
    }

    #[test]
    fn lists_an_endpoint_an_unrelated_session_holds_never_its_own_a_forks_or_a_reuses() {
        let all = sessions(&[
            ("11111111", Some("lane-a")),
            ("22222222", Some("lane-b")),
            ("11111111", Some("claude-proj-11")),
            ("11111111", Some("lane-c")),
            ("44444444", Some("lane-d")),
            ("11111111", Some("lane-d")),
            ("55555555", None),
        ]);
        let agents = Json::Arr(vec![
            agent("ep_a", "lane-a", Some(S), None),
            agent("ep_b", "lane-b", Some(F), Some(X)),
            agent("ep_p", "claude-proj-11", Some(X), None),
            agent("ep_c", "lane-c", None, None),
            agent("ep_d", "lane-d", Some(R), None),
        ]);
        assert_eq!(
            mismatch_report(&all, Some(&agents), &[]).unwrap(),
            ["me/claude-proj-11 ep_p: bg 11111111 but held by session 22222222"]
        );
        assert_eq!(
            mismatch_report(&all[..2], Some(&agents), &[]).unwrap(),
            ["no mismatched endpoints"]
        );
    }

    #[test]
    fn lists_an_endpoint_a_rehome_moved_off_a_background_name_once() {
        let all = sessions(&[("11111111", Some("lane-a")), ("22222222", Some("worker-b"))]);
        let agents = Json::Arr(vec![
            agent("ep_a", "worker-b", Some(X), None),
            agent("ep_o", "lane-o", Some(F), None),
        ]);
        let rehome = |endpoint: &str, from: &str| {
            Json::object(vec![
                ("endpoint", Json::str(endpoint)),
                (
                    "detail",
                    Json::object(vec![
                        ("from", Json::str(from)),
                        ("to", Json::str("claude-proj-11")),
                    ]),
                ),
            ])
        };
        assert_eq!(
            mismatch_report(
                &all,
                Some(&agents),
                &[
                    rehome("me/worker-b", "lane-a"),
                    rehome("ep_a", "lane-a"),
                    rehome("me/lane-o", "unknown"),
                ]
            )
            .unwrap(),
            ["me/worker-b ep_a (was me/lane-a): bg 11111111 but held by session 22222222"]
        );
        let own = Json::Arr(vec![agent("ep_a", "worker-b", Some(S), None)]);
        assert_eq!(
            mismatch_report(&all[..1], Some(&own), &[rehome("me/worker-b", "lane-a")]).unwrap(),
            ["no mismatched endpoints"]
        );
    }

    #[test]
    fn a_missing_session_field_throws_as_javascript_does() {
        let all = sessions(&[("11111111", Some("lane-a"))]);
        let agents = Json::Arr(vec![Json::object(vec![
            ("id", Json::str("ep_a")),
            ("handle", Json::str("lane-a")),
        ])]);
        assert_eq!(
            mismatch_report(&all, Some(&agents), &[]),
            Err(thrown(
                "Cannot read properties of undefined (reading 'startsWith')".into()
            ))
        );
        assert_eq!(
            mismatch_report(&all, None, &[]),
            Err(thrown(
                "Cannot read properties of undefined (reading 'map')".into()
            ))
        );
    }
}
