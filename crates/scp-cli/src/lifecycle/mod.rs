//! Join, name, leave, adopt, link, unlink, hibernate, end, machine and relink.

pub mod join;
pub mod relink;

use crate::claude::bg_plan::parse_seconds;
use crate::fleet::json::Json;
use crate::fleet::view::{text, truthy, wake_text};
use crate::fleet::{ask, missing, result_of, thrown};
use crate::open::{Opened, runtime, start_broker, terminal_attached};
use crate::term::{note, out};
use crate::{Call, Done, Fail, Run, Verb, usage};
use scp_core::protocol::CLI_NAME;
use scp_mcp::LocalFuture;
use scp_mcp::client::{CallError, Start, connect_or_start, relay_dir};
use scp_mcp::identity::safe_cwd;
use scp_mcp::render::{js_space, short_id};
use scp_mcp::tools::get;
use serde_json::{Map, Value};
use std::rc::Rc;

pub const VERBS: &[Verb] = &[
    Verb {
        name: "join",
        run: Run::Parsed(join::join),
    },
    Verb {
        name: "name",
        run: Run::Opened(name),
    },
    Verb {
        name: "leave",
        run: Run::Opened(leave),
    },
    Verb {
        name: "adopt",
        run: Run::Parsed(adopt),
    },
    Verb {
        name: "link",
        run: Run::Opened(link),
    },
    Verb {
        name: "unlink",
        run: Run::Opened(unlink),
    },
    Verb {
        name: "hibernate",
        run: Run::Opened(hibernate),
    },
    Verb {
        name: "end",
        run: Run::Opened(end),
    },
    Verb {
        name: "machine",
        run: Run::Opened(machine),
    },
    Verb {
        name: "relink",
        run: Run::Opened(relink::relink),
    },
];

/// `value.key`, throwing as JavaScript does when `value` is undefined or null
fn read<'j>(value: Option<&'j Json>, key: &str) -> Result<Option<&'j Json>, Fail> {
    match missing(value, key) {
        Some(fail) => Err(fail),
        None => Ok(value.and_then(|v| v.get(key))),
    }
}

/// `${result.endpoint.address}`
fn address(result: &Json) -> Result<String, Fail> {
    Ok(text(read(result.get("endpoint"), "address")?))
}

fn me_kind(opened: &Opened) -> Option<&str> {
    get(&opened.me, "kind").and_then(Value::as_str)
}

fn printed(json: bool, result: &Json, line: impl FnOnce() -> Result<String, Fail>) -> Done {
    if json {
        out(&result.pretty());
    } else {
        out(&line()?);
    }
    Ok(0)
}

fn name<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let flags = &call.parsed;
        let words = &flags.positionals;
        if words.len() > 1 {
            return Err(usage(format!(
                "{CLI_NAME} name takes one handle, or none to print your address"
            )));
        }
        let endpoint = flags.text("endpoint");
        let Some(handle) = words.first() else {
            if endpoint.is_some() {
                return Err(usage(format!(
                    "{CLI_NAME} name --endpoint EP takes the new handle"
                )));
            }
            if me_kind(opened) != Some("agent") {
                return Err(usage(format!(
                    "{CLI_NAME} name: this shell is no joined session; {CLI_NAME} join <name> joins it"
                )));
            }
            let address = get(&opened.me, "address");
            if flags.on("json") {
                let entries = address.map(|a| ("address", Json::from(a)));
                out(&Json::object(entries.into_iter().collect()).pretty());
            } else {
                out(&text(address.map(Json::from).as_ref()));
            }
            return Ok(0);
        };
        let before = match endpoint {
            Some(endpoint) => Some(Json::str(endpoint)),
            None => get(&opened.me, "address").map(Json::from),
        };
        let mut params = vec![("handle", Value::from(handle.as_str()))];
        if let Some(endpoint) = endpoint {
            params.push(("endpoint", Value::from(endpoint)));
        }
        if flags.on("take-over") {
            params.push(("take_over", Value::Bool(true)));
        }
        let view = ask(opened, "rename", params).await?;
        printed(flags.on("json"), &view, || {
            let now = view.get("address");
            Ok(match before.as_ref() {
                Some(before) if truthy(Some(before)) && Some(before) != now => {
                    format!("{} is now {}", text(Some(before)), text(now))
                }
                _ => text(now),
            })
        })
    })
}

fn leave<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let flags = &call.parsed;
        if !flags.positionals.is_empty() {
            return Err(usage(format!(
                "{CLI_NAME} leave takes no arguments (--endpoint EP for the human at a terminal)"
            )));
        }
        let params = flags
            .text("endpoint")
            .map(|endpoint| ("endpoint", Value::from(endpoint)))
            .into_iter()
            .collect();
        let view = ask(opened, "leave", params).await?;
        printed(flags.on("json"), &view, || {
            Ok(format!(
                "{} left the relay: offline, no messages pushed; its mail is kept until {CLI_NAME} join",
                text(view.get("address"))
            ))
        })
    })
}

/// opens as the human at this terminal, with no lineage and none of `open()`'s identity checks (`openAdoptHuman`)
async fn open_adopt_human(call: &Call<'_>) -> Result<Opened, Fail> {
    if call.parsed.has("machine") {
        return Err(usage(
            "--machine names the machine of the cloud transport: add --cloud",
        ));
    }
    let dir = relay_dir(call.env);
    let start: Start = {
        let (dir, env) = (dir.to_string_lossy().into_owned(), call.env.clone());
        Rc::new(move || start_broker(&dir, &env))
    };
    let client = connect_or_start(&dir, Some(start)).await?;
    let mut hello = Map::new();
    hello.insert("human".into(), Value::Bool(true));
    hello.insert("tty".into(), Value::Bool(true));
    hello.insert("cwd".into(), Value::from(safe_cwd()));
    hello.insert("brief".into(), Value::Bool(true));
    let reply = client.hello_line(hello).await;
    let hello = match reply.map_err(Fail::from).and_then(|line| result_of(&line)) {
        Ok(hello) => hello,
        Err(fail) => {
            client.close();
            return Err(fail);
        }
    };
    let endpoint = hello.get("endpoint").cloned().unwrap_or(Json::Null);
    let hello = hello.to_value();
    Ok(Opened {
        client,
        me: get(&hello, "endpoint").cloned().unwrap_or(Value::Null),
        endpoint,
        broker: get(&hello, "broker").cloned().unwrap_or(Value::Null),
        bound: Some("human"),
        harness_pid: None,
    })
}

fn adopt(call: &Call) -> Done {
    let human = call.parsed.has("parent") && !call.parsed.has("as") && terminal_attached(false);
    if !human {
        return crate::open::with_opened(call, adopt_as);
    }
    if let Ok(exe) = std::env::current_exe() {
        scp_mcp::spawn::set_native_daemon(exe);
    }
    let runtime = runtime()?;
    let local = tokio::task::LocalSet::new();
    let done = local.block_on(&runtime, async {
        let opened = open_adopt_human(call).await?;
        let done = adopt_as(call, &opened).await;
        opened.client.close();
        done
    });
    drop(local);
    runtime.shutdown_background();
    done
}

fn adopt_as<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let flags = &call.parsed;
        let [child] = flags.positionals.as_slice() else {
            return Err(usage(format!(
                "{CLI_NAME} adopt takes the child to link: {CLI_NAME} adopt <child> [--parent <p>]"
            )));
        };
        let parent = flags.text("parent");
        if parent.is_none() && me_kind(opened) != Some("agent") {
            return Err(usage(format!(
                "{CLI_NAME} adopt: name the parent with --parent <p> (run from an agent's shell, it defaults to that agent)"
            )));
        }
        let mut params = vec![("endpoint", Value::from(child.as_str()))];
        if let Some(parent) = parent {
            params.push(("parent", Value::from(parent)));
        }
        let result = ask(opened, "adopt", params).await?;
        printed(flags.on("json"), &result, || {
            let held = result.get("held");
            if truthy(held) {
                return Ok(format!(
                    "held for review by your human: hold {}; nothing was delivered",
                    text(read(held, "hold_id")?)
                ));
            }
            let requested = result.get("requested");
            if truthy(requested) {
                let child = address(&result)?;
                let id = match requested {
                    Some(Json::Str(id)) => short_id(id),
                    _ => return Err(thrown("id.slice is not a function".into())),
                };
                return Ok(format!(
                    "asked {child} to link under {}; it accepts with {CLI_NAME} link accept {id}",
                    text(result.get("parent"))
                ));
            }
            Ok(format!(
                "{} now sits under {}",
                address(&result)?,
                text(result.get("parent"))
            ))
        })
    })
}

fn link<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let flags = &call.parsed;
        let [accept, id] = flags.positionals.as_slice() else {
            return Err(usage(format!("{CLI_NAME} link takes accept <id>")));
        };
        if accept != "accept" {
            return Err(usage(format!("{CLI_NAME} link takes accept <id>")));
        }
        let result = ask(
            opened,
            "link_accept",
            vec![("id", Value::from(id.as_str()))],
        )
        .await?;
        printed(flags.on("json"), &result, || {
            Ok(format!(
                "{} now sits under {}",
                address(&result)?,
                text(result.get("parent"))
            ))
        })
    })
}

fn unlink<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let flags = &call.parsed;
        if flags.positionals.len() > 1 {
            return Err(usage(format!(
                "{CLI_NAME} unlink takes one child, or none for this session"
            )));
        }
        let params = flags
            .positionals
            .first()
            .map(|child| ("endpoint", Value::from(child.as_str())))
            .into_iter()
            .collect();
        let result = ask(opened, "unlink", params).await?;
        printed(flags.on("json"), &result, || {
            Ok(format!(
                "{} is a root again (was under {})",
                address(&result)?,
                text(result.get("parent"))
            ))
        })
    })
}

/// an endpoint's presence as a line shows it (`presenceText`)
fn presence_text(e: &Json) -> String {
    let presence = e.get("presence");
    if presence.and_then(Json::as_str) == Some("hibernated") {
        return "hibernated (wakeable)".into();
    }
    let wake = e.get("wake");
    let unwoken = !truthy(wake) || wake.and_then(Json::as_str) == Some("none");
    if e.get("kind").and_then(Json::as_str) == Some("agent")
        && presence.and_then(Json::as_str) == Some("idle")
        && unwoken
    {
        return "idle (next turn)".into();
    }
    text(presence)
}

fn hibernate<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let flags = &call.parsed;
        let words = &flags.positionals;
        if words.len() > 1 {
            return Err(usage(format!(
                "{CLI_NAME} hibernate takes at most one endpoint"
            )));
        }
        if flags.on("gone") && flags.has("wake") {
            return Err(usage("--gone and --wake: pick one"));
        }
        let wake = if flags.on("gone") {
            Some("none")
        } else {
            flags.text("wake")
        };
        let Some(wake) = wake else {
            return Err(usage(format!(
                "{CLI_NAME} hibernate takes --wake <provider>, or --wake none (--gone) to clear it"
            )));
        };
        if wake == "none" && (flags.has("ref") || flags.has("eta")) {
            return Err(usage(
                "--ref and --eta go with a provider, not with --wake none",
            ));
        }
        if flags.on("all") && !words.is_empty() {
            return Err(usage(format!(
                "{CLI_NAME} hibernate --all names no endpoint"
            )));
        }
        let eta = match flags.text("eta") {
            Some(eta) => Some(
                parse_seconds(eta, "--eta")
                    .map_err(|message| Fail::Call(CallError::Io(message)))?,
            ),
            None => None,
        };
        let mut params = Vec::new();
        if flags.on("all") {
            params.push(("all", Value::Bool(true)));
        } else if let Some(endpoint) = words.first() {
            params.push(("endpoint", Value::from(endpoint.as_str())));
        }
        params.push(("wake", Value::from(wake)));
        if let Some(reference) = flags.text("ref") {
            params.push(("ref", Value::from(reference)));
        }
        if let Some(eta) = eta {
            params.push(("eta_s", crate::messages::number(eta.round())));
        }
        let result = ask(opened, "hibernate", params).await?;
        if flags.on("json") {
            out(&result.pretty());
            return Ok(0);
        }
        let endpoints = match result.get("endpoints") {
            None | Some(Json::Null) => match result.get("endpoint") {
                endpoint if truthy(endpoint) => endpoint.cloned().into_iter().collect(),
                _ => Vec::new(),
            },
            Some(Json::Arr(items)) => items.clone(),
            Some(_) => return Err(thrown("result.endpoints is not iterable".into())),
        };
        for e in &endpoints {
            let woken = if e.get("presence").and_then(Json::as_str) == Some("hibernated") {
                format!(", woken by {}", wake_text(e))
            } else {
                String::new()
            };
            out(&format!(
                "{} {}{woken}",
                text(e.get("address")),
                presence_text(e)
            ));
        }
        if truthy(result.get("mirrored")) {
            note("the hub has it: the machine may be suspended now");
        }
        Ok(0)
    })
}

/// `text.replace(/\s+/g, " ").trim()`
pub fn one_line(text: &str) -> String {
    text.split(js_space)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn end<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let flags = &call.parsed;
        let [worker] = flags.positionals.as_slice() else {
            return Err(usage(format!(
                "{CLI_NAME} end takes the worker to let go: {CLI_NAME} end <worker>"
            )));
        };
        let result = ask(
            opened,
            "spawn_end",
            vec![("endpoint", Value::from(worker.as_str()))],
        )
        .await?;
        let json = flags.on("json");
        let runner = result.get("runner");
        if let Some(runner) = runner.filter(|r| truthy(Some(r))) {
            if json {
                out(&result.pretty());
            } else {
                let address = match result.get("endpoint").and_then(|e| e.get("address")) {
                    None | Some(Json::Null) => worker.clone(),
                    address => text(address),
                };
                let code = match runner.get("code") {
                    None => String::new(),
                    code => format!(" (exit {})", text(code)),
                };
                let stderr = match runner.get("stderr") {
                    stderr if !truthy(stderr) => String::new(),
                    Some(Json::Str(stderr)) => format!(": {}", one_line(stderr)),
                    _ => {
                        return Err(thrown(
                            "result.runner.stderr.replace is not a function".into(),
                        ));
                    }
                };
                out(&format!(
                    "{address} runner {}: {}{code}{stderr}",
                    text(runner.get("name")),
                    text(runner.get("stop"))
                ));
            }
            let stop = runner.get("stop").and_then(Json::as_str);
            return Ok(if matches!(stop, Some("failed" | "timeout")) {
                1
            } else {
                0
            });
        }
        printed(json, &result, || {
            Ok(if truthy(result.get("held")) {
                format!(
                    "{} ended: no message resumes it now; messages to it queue as for any offline agent",
                    address(&result)?
                )
            } else {
                format!(
                    "{} was not held for a resume; marked ended",
                    address(&result)?
                )
            })
        })
    })
}

fn machine<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let flags = &call.parsed;
        let words = &flags.positionals;
        if words.first().map(String::as_str) != Some("wake-url") {
            return Err(usage(format!(
                "{CLI_NAME} machine takes wake-url <url> [--secret-env VAR] | wake-url --clear"
            )));
        }
        let json = flags.on("json");
        if flags.on("clear") {
            if words.len() > 1 || flags.has("secret-env") {
                return Err(usage(format!(
                    "{CLI_NAME} machine wake-url --clear takes no url"
                )));
            }
            let result = ask(opened, "machine_wake", vec![("url", Value::Null)]).await?;
            return printed(json, &result, || Ok("machine waker cleared".into()));
        }
        if words.len() != 2 {
            return Err(usage(format!(
                "{CLI_NAME} machine wake-url takes one url, or --clear"
            )));
        }
        let name = flags
            .text("secret-env")
            .unwrap_or("SCP_MACHINE_WAKE_SECRET");
        let Some(secret) = call.env.get(name).filter(|s| !s.is_empty()) else {
            return Err(usage(format!(
                "set ${name} to the waker's secret (16 to 256 characters); it is never read from the command line"
            )));
        };
        let result = ask(
            opened,
            "machine_wake",
            vec![
                ("url", Value::from(words[1].as_str())),
                ("secret", Value::from(secret.as_str())),
            ],
        )
        .await?;
        printed(json, &result, || {
            Ok("machine waker set; the hub signs each call with the secret".into())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_stderr_collapses_javascript_whitespace() {
        assert_eq!(one_line("  a\n\tb\u{a0}\u{feff}c \u{2028} "), "a b c");
        assert_eq!(one_line("\u{3000}"), "");
        assert_eq!(one_line("x\u{85}y"), "x\u{85}y");
    }

    #[test]
    fn an_eta_beyond_a_javascript_number_goes_as_null() {
        let eta =
            |text: &str| crate::messages::number(parse_seconds(text, "--eta").unwrap().round());
        assert_eq!(eta("90m"), Value::from(5400));
        assert_eq!(eta(&"9".repeat(400)), Value::Null);
        assert_eq!(eta(&format!("1{}", "0".repeat(20))).as_f64(), Some(1e20));
    }

    #[test]
    fn presence_reads_as_the_cli_shows_it() {
        let e = |entries: Vec<(&str, Json)>| Json::object(entries);
        assert_eq!(
            presence_text(&e(vec![("presence", Json::str("hibernated"))])),
            "hibernated (wakeable)"
        );
        assert_eq!(
            presence_text(&e(vec![
                ("kind", Json::str("agent")),
                ("presence", Json::str("idle")),
                ("wake", Json::str("none")),
            ])),
            "idle (next turn)"
        );
        assert_eq!(
            presence_text(&e(vec![
                ("kind", Json::str("agent")),
                ("presence", Json::str("idle")),
                ("wake", Json::str("claude")),
            ])),
            "idle"
        );
        assert_eq!(presence_text(&e(vec![])), "undefined");
    }
}
