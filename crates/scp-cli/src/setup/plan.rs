//! What `swarm setup` would change: one step per mount, rule list and hooks file, each applied later against the file as it is then.

use super::files::{
    Apply, Edit, WriteOptions, backup, exists, file_mode, fs_error, json_edit, link_problem,
    read_json, read_text, write_file,
};
use super::harness::{
    Change, HOOKED, REMOTE_KEYS, RunResult, SERVER, added_item, agy_rules, agy_settings_file,
    entry_enabled, entry_right, entry_vars, env_key, forget, is_object, item_file, item_harness,
    item_kind, last_line, local_type, mounted_entry, muse_installed_file, native_vars, redacted,
    remember, run_command, same_item, shell_words, shown, without_remote,
};
use super::hook_cmd::{AGY_HOOK_SET, BLOCK_STOP, HookLaunch, has_our_hooks, merge_hooks};
use super::hooks_install::{
    HookError, LONE_SURROGATE, desired_hooks, gone_client_line, gone_clients, hooks_target,
    launcher_prefixes, lone_surrogate, mergeable, resolved,
};
use crate::fleet::json::Json;
use crate::fleet::mounts::{entry_argv, mcp_file};
use crate::spawn::argv::{Mount, mount_vars, pin_mode};
use scp_core::protocol::CLI_NAME;
use scp_mcp::identity::git_toplevel;
use scp_mcp::ps::{Env, basename, dirname, join};
use scp_mcp::render::js_space;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

type Found = HashMap<&'static str, String>;

/// after a failed apply: what of the step is on disk anyway, which the manifest then records
type Landed = Box<dyn Fn() -> Option<String>>;

pub struct Step {
    pub harness: &'static str,
    pub label: &'static str,
    pub file: String,
    pub plan: Vec<String>,
    pub apply: Apply,
    pub manifest: Option<Change>,
    pub landed: Option<Landed>,
}

/// the hooks a harness gets: the file, the installer it follows, and whether its stop is held
pub struct HookTarget {
    pub kind: &'static str,
    pub file: String,
    pub block_stop: bool,
    pub launch: HookLaunch,
}

pub enum Line {
    Text(String),
    Step(usize),
}

#[derive(Default)]
pub struct Plan {
    pub steps: Vec<Step>,
    pub lines: Vec<(&'static str, Line)>,
    pub problems: usize,
    pub hooks: HashMap<&'static str, HookTarget>,
}

impl Plan {
    fn note(&mut self, harness: &'static str, text: impl Into<String>) {
        self.lines.push((harness, Line::Text(text.into())));
    }

    /// a note for something setup could not do: the run then exits non-zero
    fn problem(&mut self, harness: &'static str, text: impl AsRef<str>) {
        self.problems += 1;
        self.note(harness, format!("! {}", text.as_ref()));
    }

    fn add(&mut self, step: Step) {
        self.lines
            .push((step.harness, Line::Step(self.steps.len())));
        self.steps.push(step);
    }
}

pub struct Ctx {
    pub env: Rc<Env>,
    pub cwd: String,
    pub now_s: i64,
    pub found: Found,
    pub added: Vec<Json>,
    pub wanted: Vec<&'static str>,
    pub block_stop: bool,
    pub native: Option<String>,
    /// the argv prefix the Claude Code and codex hooks run, which desktop apps start without the login shell's PATH
    pub hook_launch: Option<Vec<String>>,
}

impl Ctx {
    /// the launch the Claude Code and codex hooks of this setup run
    fn launch(&self) -> HookLaunch {
        HookLaunch {
            launcher: self.hook_launch.clone(),
            native: self.native.clone(),
        }
    }
}

fn no_action() -> Apply {
    Box::new(|| Ok(None))
}

/// Runs harness CLI commands that edit `target`: backed up first, its mode put back afterwards whatever happens. When a later command
/// fails, `rollback` puts back what the earlier ones changed.
fn run_editing(
    target: &str,
    now_s: i64,
    env: &Env,
    commands: &[Vec<String>],
    rollback: &[Vec<String>],
) -> Result<Option<String>, String> {
    let file = resolved(target)?;
    let before = if exists(&file) {
        Some(file_mode(&file)?)
    } else {
        None
    };
    let saved = match before {
        Some(_) => Some(backup(&file, now_s)?),
        None => None,
    };
    let ran = (|| {
        for (index, argv) in commands.iter().enumerate() {
            let result = run_command(argv, env, None);
            if result.code == 0 {
                continue;
            }
            let failed = format!(
                "{} {} exited {}: {}",
                basename(&argv[0]),
                argv[1..argv.len().min(3)].join(" "),
                result.code,
                last_line(&result.output)
            );
            if index == 0 || rollback.is_empty() {
                return Err(failed);
            }
            let undone = rollback
                .iter()
                .all(|step| run_command(step, env, None).code == 0);
            let how = if undone {
                "the previous mount is back".to_owned()
            } else {
                format!(
                    "putting the previous mount back failed too, it is in {}",
                    saved.as_deref().unwrap_or("undefined")
                )
            };
            return Err(format!("{failed}; {how}"));
        }
        Ok(())
    })();
    if let Some(before) = before
        && exists(&file)
        && file_mode(&file).is_ok_and(|mode| mode != before)
    {
        std::fs::set_permissions(&file, std::os::unix::fs::PermissionsExt::from_mode(before))
            .map_err(fs_error("chmod", &file))?;
    }
    ran.map(|()| saved)
}

/// the keys of a mount each harness CLI's `mcp add` writes; it drops the others
fn cli_keeps(harness: &str, key: &str) -> bool {
    let last = if harness == "agy" {
        "disabled"
    } else {
        "enabled"
    };
    ["command", "args", "env", last].contains(&key)
}

/// Claude's local-scope scp entries (in ~/.claude.json projects) and project-scope ones (a project's .mcp.json)
fn claude_shadows(file: &str, cwd: &str) -> Vec<String> {
    let mut found = Vec::new();
    let config = match resolved(file).and_then(|target| read_json(&target)) {
        Ok(config) => config,
        Err(_) => return found,
    };
    let mut dirs = vec![git_toplevel(cwd).unwrap_or_else(|| cwd.to_owned())];
    let projects = config.as_ref().and_then(|c| c.get("projects"));
    if let Some(projects) = projects.filter(|p| is_object(p)) {
        for (dir, project) in projects.entries() {
            if !dirs.iter().any(|known| known == dir) {
                dirs.push(dir.to_owned());
            }
            let servers = project.get("mcpServers").filter(|s| is_object(s));
            if servers.is_some_and(|s| s.get(SERVER).is_some()) {
                found.push(format!("a local-scope {SERVER} for {dir} (in {file})"));
            }
        }
    }
    for dir in dirs {
        let path = join(&[&dir, ".mcp.json"]);
        let Ok(Some(config)) = read_json(&path) else {
            continue;
        };
        let servers = config.get("mcpServers").filter(|s| is_object(s));
        if servers.is_some_and(|s| s.get(SERVER).is_some()) {
            found.push(format!("a project-scope {SERVER} in {path}"));
        }
    }
    found
}

fn strings(words: &[String]) -> Json {
    Json::Arr(words.iter().map(|w| Json::str(w.as_str())).collect())
}

/// `object` with `extra` set over it, a key it has keeping its place
fn spread(object: &Json, extra: &Json) -> Json {
    let mut out = object.clone();
    for (key, value) in extra.entries() {
        out.set(key, value.clone());
    }
    out
}

/// the JSON file a harness CLI is handed its entry from, read for what a rewrite through it would lose: a lone surrogate the entry holds
fn entry_loses(harness: &str, file: &str, entry: Option<&Json>) -> bool {
    let Some(entry) = entry.filter(|_| harness == "claude" || harness == "agy") else {
        return false;
    };
    entry.compact().contains('\u{fffd}') && read_text(file).is_ok_and(|text| lone_surrogate(&text))
}

/// whether a line of `text` starts with a comment: `/^\s*#/m`
fn has_comment(text: &str) -> bool {
    text.split(line_end)
        .any(|line| line.trim_start_matches(js_space).starts_with('#'))
}

fn line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// the mount step for one harness, or a note when it is already in place
pub fn plan_mount(
    plan: &mut Plan,
    harness: &'static str,
    mount: &Mount,
    ctx: &Ctx,
) -> Result<(), String> {
    let now_s = ctx.now_s;
    let cli = ctx.found[harness].clone();
    let file = mcp_file(harness, &ctx.env);
    let argv = &mount.argv;
    if let Some(blocked) = link_problem(&file, harness != "opencode" && harness != "muse") {
        plan.problem(harness, format!("mcp: skipped, {blocked}"));
        return Ok(());
    }
    let entry = match mounted_entry(harness, &file) {
        Ok(entry) => entry,
        Err(error) => {
            plan.problem(
                harness,
                format!("mcp: skipped, {file} is unreadable ({error}); fix it or rerun after"),
            );
            return Ok(());
        }
    };
    if harness == "claude" {
        for shadow in claude_shadows(&file, &ctx.cwd) {
            plan.note(
                harness,
                format!(
                    "mcp: warning, {shadow}: in that project it is used instead of the user mount"
                ),
            );
        }
    }
    let had = entry_vars(harness, entry.as_ref());
    let pinned = pin_mode(&had, &ctx.env);
    if let Some(entry) = &entry
        && entry_right(harness, entry, mount)
        && pinned == had
    {
        plan.note(harness, format!("mcp: up to date in {file}"));
        return Ok(());
    }
    if entry_loses(harness, &file, entry.as_ref()) {
        plan.problem(harness, format!("mcp: skipped, {file}: {LONE_SURROGATE}"));
        return Ok(());
    }
    let current = entry.as_ref().map(|entry| entry_argv(harness, entry));
    let revars = mount.native || native_vars(&had);
    let vars = if revars {
        mount_vars(&pinned, mount)
    } else {
        pinned.clone()
    };
    let with_vars = if revars || pinned != had {
        Json::object(vec![(env_key(harness), vars.clone())])
    } else {
        Json::Obj(Vec::new())
    };
    let manifest: Option<Change> = entry
        .is_none()
        .then(|| remember(added_item(harness, "mcp", &file)));
    let verb = match &entry {
        Some(entry) => {
            let now = current
                .as_deref()
                .map(shell_words)
                .filter(|text| !text.is_empty());
            format!(
                "update {SERVER} (now: {}{})",
                now.as_deref().unwrap_or("unparsed"),
                if entry_enabled(harness, entry) {
                    ""
                } else {
                    ", disabled; setup enables it"
                }
            )
        }
        None => format!("add {SERVER}"),
    };
    let dropped: Vec<&str> = REMOTE_KEYS
        .iter()
        .filter(|key| entry.as_ref().is_some_and(|e| e.get(key).is_some()))
        .copied()
        .collect();
    let cli_step = |plan: &mut Plan, commands: Vec<Vec<String>>, rollback: Vec<Vec<String>>| {
        let mut lines = vec![format!("{verb} in {file}")];
        lines.extend(commands.iter().map(|argv| shown(argv)));
        let (env, target) = (ctx.env.clone(), file.clone());
        let (landed_harness, landed_file) = (harness, file.clone());
        plan.add(Step {
            harness,
            label: "mcp",
            file: file.clone(),
            plan: lines,
            apply: Box::new(move || run_editing(&target, now_s, &env, &commands, &rollback)),
            manifest: manifest.clone(),
            landed: Some(Box::new(move || {
                match mounted_entry(landed_harness, &landed_file) {
                    Ok(Some(_)) => Some("the mount it wrote".to_owned()),
                    _ => None,
                }
            })),
        });
    };
    let words = |list: &[&str]| -> Vec<String> { list.iter().map(|w| (*w).to_owned()).collect() };
    match harness {
        "claude" => {
            let add_json = |json: &Json| {
                let mut command = vec![cli.clone()];
                command.extend(words(&["mcp", "add-json", "--scope", "user", SERVER]));
                command.push(json.compact());
                command
            };
            let Some(entry) = &entry else {
                let command = if mount.env.is_empty() {
                    let mut command = vec![cli.clone()];
                    command.extend(words(&["mcp", "add", "--scope", "user", SERVER, "--"]));
                    command.extend(argv.iter().cloned());
                    command
                } else {
                    add_json(&Json::object(vec![
                        ("type", Json::str("stdio")),
                        ("command", Json::str(argv[0].as_str())),
                        ("args", strings(&argv[1..])),
                        ("env", vars.clone()),
                    ]))
                };
                cli_step(plan, vec![command], Vec::new());
                return Ok(());
            };
            let merged = spread(
                &spread(
                    &without_remote(entry),
                    &Json::object(vec![
                        ("type", Json::str("stdio")),
                        ("command", Json::str(argv[0].as_str())),
                        ("args", strings(&argv[1..])),
                    ]),
                ),
                &with_vars,
            );
            if !dropped.is_empty() {
                plan.note(
                    harness,
                    format!(
                        "mcp: the update drops {} from the entry; the backup keeps them",
                        dropped.join(", ")
                    ),
                );
            }
            let mut remove = vec![cli.clone()];
            remove.extend(words(&["mcp", "remove", "--scope", "user", SERVER]));
            cli_step(plan, vec![remove, add_json(&merged)], vec![add_json(entry)]);
        }
        "codex" | "grok" | "agy" => {
            let raw = entry
                .as_ref()
                .and_then(|e| e.get("env"))
                .filter(|vars| is_object(vars));
            let mut lost: Vec<String> = entry
                .as_ref()
                .map(|e| {
                    e.entries()
                        .into_iter()
                        .map(|(key, _)| key)
                        .filter(|key| !cli_keeps(harness, key))
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            if let Some(raw) = raw {
                lost.extend(
                    raw.entries()
                        .into_iter()
                        .filter(|(_, value)| !matches!(value, Json::Str(_)))
                        .map(|(key, _)| format!("env.{key}")),
                );
            }
            let mut command = vec![cli.clone(), "mcp".to_owned(), "add".to_owned()];
            if harness == "grok" {
                command.extend(words(&["--scope", "user"]));
            }
            for (key, value) in vars.entries() {
                command.push("--env".into());
                command.push(format!("{key}={}", value.as_str().unwrap_or_default()));
            }
            command.extend(words(&[SERVER, "--"]));
            command.extend(argv.iter().cloned());
            cli_step(plan, vec![command], Vec::new());
            if !lost.is_empty() {
                plan.note(
                    harness,
                    format!(
                        "mcp: {harness} mcp add writes the entry anew and drops {} from it; the backup keeps them",
                        lost.join(", ")
                    ),
                );
            }
            if harness == "grok" && exists(&file) && has_comment(&read_text(&file)?) {
                plan.note(
                    harness,
                    format!(
                        "mcp: grok mcp add rewrites {file} without its comments; the backup keeps them"
                    ),
                );
            }
        }
        _ => plan_json_mount(
            plan,
            harness,
            mount,
            JsonMount {
                file: &file,
                entry: entry.as_ref(),
                with_vars: &with_vars,
                verb: &verb,
                dropped: &dropped,
                manifest,
                now_s,
            },
        ),
    }
    Ok(())
}

/// the parts of a mount opencode and muse keep in a JSON file setup edits itself
struct JsonMount<'a> {
    file: &'a str,
    entry: Option<&'a Json>,
    with_vars: &'a Json,
    verb: &'a str,
    dropped: &'a [&'a str],
    manifest: Option<Change>,
    now_s: i64,
}

fn plan_json_mount(plan: &mut Plan, harness: &'static str, mount: &Mount, parts: JsonMount) {
    let JsonMount {
        file,
        entry,
        with_vars,
        verb,
        dropped,
        manifest,
        now_s,
    } = parts;
    let opencode = harness == "opencode";
    let key = if opencode { "mcp" } else { "mcpServers" };
    let argv = &mount.argv;
    let kind = local_type(harness).unwrap_or_default();
    let fresh = spread(
        &if opencode {
            Json::object(vec![
                ("type", Json::str("local")),
                ("command", strings(argv)),
                ("enabled", Json::Bool(true)),
            ])
        } else {
            Json::object(vec![
                ("type", Json::str("stdio")),
                ("command", Json::str(argv[0].as_str())),
                ("args", strings(&argv[1..])),
                ("mode", Json::str("optional")),
            ])
        },
        with_vars,
    );
    let mut changed = Json::Obj(Vec::new());
    if entry.is_some_and(|e| e.get("type").and_then(Json::as_str) != Some(kind)) {
        changed.set("type", Json::str(kind));
    }
    if opencode {
        changed.set("command", strings(argv));
        changed.set("enabled", Json::Bool(true));
    } else {
        changed.set("command", Json::str(argv[0].as_str()));
        changed.set("args", strings(&argv[1..]));
        if entry.is_some_and(|e| e.get("enabled").is_some()) {
            changed.set("enabled", Json::Bool(true));
        }
    }
    let changed = spread(&changed, with_vars);
    let value = Rc::new(RefCell::new(fresh.clone()));
    let edit: Edit = {
        let (changed, value) = (changed.clone(), value.clone());
        Rc::new(move |config: &Json| {
            if !opencode && config.get("mcp_servers").is_some() {
                return Err("it has a mcp_servers key, and Muse drops every MCP server when both mcp_servers and mcpServers exist; merge them by hand first".into());
            }
            let table = match config.get(key) {
                None | Some(Json::Null) => Json::Obj(Vec::new()),
                Some(table) => table.clone(),
            };
            if !is_object(&table) {
                return Err(format!("its {key} key is not an object"));
            }
            let next = match table.get(SERVER).filter(|e| is_object(e)) {
                Some(existing) => spread(&without_remote(existing), &changed),
                None => fresh.clone(),
            };
            *value.borrow_mut() = next.clone();
            let mut base = if config.entries().is_empty() {
                if opencode {
                    Json::object(vec![(
                        "$schema",
                        Json::str("https://opencode.ai/config.json"),
                    )])
                } else {
                    Json::object(vec![("schema_version", Json::Num(1.0))])
                }
            } else {
                config.clone()
            };
            let mut servers = table;
            servers.set(SERVER, next);
            base.set(key, servers);
            Ok(Some(base))
        })
    };
    let apply = match json_edit(file, edit, now_s) {
        Ok(Some(apply)) => apply,
        Ok(None) => return,
        Err(error) => {
            plan.problem(harness, format!("mcp: skipped, {file}: {error}"));
            return;
        }
    };
    let detail = if entry.is_some() {
        let fields: Vec<String> = changed
            .entries()
            .into_iter()
            .map(|(name, inner)| {
                let shown = redacted(&Json::object(vec![(name, inner.clone())]));
                let shown = shown.get(name).cloned().unwrap_or(Json::Null);
                format!("{key}.{SERVER}.{name} = {}", shown.compact())
            })
            .collect();
        let also = if dropped.is_empty() {
            String::new()
        } else {
            format!(", and {} dropped", dropped.join(", "))
        };
        format!("{} (its other keys kept{also})", fields.join(", "))
    } else {
        format!("{key}.{SERVER} = {}", redacted(&value.borrow()).compact())
    };
    plan.add(Step {
        harness,
        label: "mcp",
        file: file.to_owned(),
        plan: vec![format!("{verb} in {file}"), detail],
        apply,
        manifest,
        landed: None,
    });
}

pub fn plan_agy_rules(plan: &mut Plan, ctx: &Ctx, remove: bool) {
    let file = agy_settings_file(&ctx.env);
    let item = added_item("agy", "rules", &file);
    let ours: Vec<Json> = ctx
        .added
        .iter()
        .find(|other| same_item(other, &item))
        .and_then(|found| found.get("rules"))
        .map(|rules| rules.items().to_vec())
        .unwrap_or_default();
    let all: Vec<Json> = agy_rules().into_iter().map(Json::Str).collect();
    let wanted = if remove { ours.clone() } else { all.clone() };
    if let Some(blocked) = link_problem(&file, false) {
        plan.problem("agy", format!("permissions: skipped, {blocked}"));
        return;
    }
    let changed: Rc<RefCell<Vec<String>>> = Rc::default();
    let kept = Rc::new(RefCell::new(0_usize));
    let edit: Edit = {
        let (changed, kept, wanted) = (changed.clone(), kept.clone(), wanted.clone());
        Rc::new(move |config: &Json| {
            if remove && config.get("permissions").is_none() {
                return Ok(None);
            }
            let permissions = match config.get("permissions") {
                None | Some(Json::Null) => Json::Obj(Vec::new()),
                Some(found) => found.clone(),
            };
            if !is_object(&permissions) {
                return Err("its permissions key is not an object".into());
            }
            let allow = match permissions.get("allow") {
                None | Some(Json::Null) => Vec::new(),
                Some(Json::Arr(items)) => items.clone(),
                Some(_) => return Err("its permissions.allow is not a list".into()),
            };
            let is_string = |rule: &Json| matches!(rule, Json::Str(_));
            *kept.borrow_mut() = if remove {
                allow
                    .iter()
                    .filter(|rule| is_string(rule) && all.contains(rule) && !wanted.contains(rule))
                    .count()
            } else {
                0
            };
            let next: Vec<Json> = if remove {
                allow
                    .iter()
                    .filter(|rule| !(is_string(rule) && wanted.contains(rule)))
                    .cloned()
                    .collect()
            } else {
                let mut next = allow.clone();
                next.extend(wanted.iter().filter(|rule| !allow.contains(rule)).cloned());
                next
            };
            let text = |rule: &Json| rule.as_str().unwrap_or_default().to_owned();
            let moved: Vec<String> = if remove {
                allow
                    .iter()
                    .filter(|rule| !next.contains(rule))
                    .map(text)
                    .collect()
            } else {
                next[allow.len()..].iter().map(text).collect()
            };
            let any = !moved.is_empty();
            *changed.borrow_mut() = moved;
            if !any {
                return Ok(None);
            }
            let mut permissions = permissions;
            permissions.set("allow", Json::Arr(next));
            let mut config = config.clone();
            config.set("permissions", permissions);
            Ok(Some(config))
        })
    };
    let edit = match json_edit(&file, edit, ctx.now_s) {
        Ok(edit) => edit,
        Err(error) => {
            plan.problem("agy", format!("permissions: skipped, {file}: {error}"));
            return;
        }
    };
    let kept = *kept.borrow();
    if kept > 0 {
        plan.note(
            "agy",
            format!(
                "permissions: keeps {kept} relay tool rule{} in {file} that setup did not add",
                if kept == 1 { "" } else { "s" }
            ),
        );
    }
    let Some(apply) = edit else {
        if !remove {
            plan.note(
                "agy",
                format!(
                    "permissions: {} relay tool rules already in {file}",
                    wanted.len()
                ),
            );
        } else if !ours.is_empty() {
            plan.add(Step {
                harness: "agy",
                label: "permissions",
                file: file.clone(),
                plan: vec![format!(
                    "forget the rules setup added to {file}, which are gone"
                )],
                apply: no_action(),
                manifest: Some(forget(item)),
                landed: None,
            });
        }
        return;
    };
    let changed = changed.borrow().clone();
    let head = format!(
        "{} {} permissions.allow rules {} {file}{}",
        if remove { "remove" } else { "add" },
        changed.len(),
        if remove { "from" } else { "to" },
        if remove {
            ""
        } else {
            " (headless agy denies MCP tools without them)"
        }
    );
    let manifest = if remove {
        forget(item)
    } else {
        let mut with_rules = item;
        with_rules.set(
            "rules",
            Json::Arr(
                changed
                    .iter()
                    .map(|rule| Json::str(rule.as_str()))
                    .collect(),
            ),
        );
        remember(with_rules)
    };
    plan.add(Step {
        harness: "agy",
        label: "permissions",
        file,
        plan: vec![head, changed.join(" ")],
        apply,
        manifest: Some(manifest),
        landed: None,
    });
}

/// whether a hooks file holds stops while messages are unread
fn holds_stops(kind: &str, target: &str) -> bool {
    let held = || -> Option<bool> {
        let file = resolved(target).ok()?;
        if !exists(&file) {
            return Some(false);
        }
        let text = read_text(&file).ok()?;
        if kind == "opencode" {
            return Some(text.contains("const BLOCK_STOP = true"));
        }
        let config = Json::parse(text.as_bytes()).filter(is_object)?;
        Some(match kind {
            "muse" => config.compact().contains(BLOCK_STOP),
            "agy" => config
                .get(AGY_HOOK_SET)
                .map_or_else(|| "null".to_owned(), Json::compact)
                .contains(BLOCK_STOP),
            _ => config
                .get("hooks")
                .map_or_else(|| "null".to_owned(), Json::compact)
                .contains(&format!(" hook {kind} {BLOCK_STOP}")),
        })
    };
    held().unwrap_or(false)
}

/// whether a hooks file already has hooks of ours, whatever their version
fn has_hooks(kind: &str, target: &str, launch: &HookLaunch) -> bool {
    let has = || -> Option<bool> {
        let file = resolved(target).ok()?;
        if !exists(&file) {
            return Some(false);
        }
        Some(match kind {
            "opencode" | "muse" => true,
            "agy" => read_json(&file)
                .ok()?
                .is_some_and(|c| c.get(AGY_HOOK_SET).is_some()),
            _ => has_our_hooks(&file, &launcher_prefixes(launch)),
        })
    };
    has().unwrap_or(false)
}

/// identifies plugin files that setup may remove
const OPENCODE_MARK: &str = "// scp:";

fn sha256(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("sha256:{hex}")
}

/// Muse's record of the scp plugin, from its installed.json: None when there is none, an error when the file cannot say
fn muse_installed(env: &Env) -> Result<Option<Json>, String> {
    let Some(config) = read_json(&muse_installed_file(env))? else {
        return Ok(None);
    };
    Ok(config
        .get("plugins")
        .filter(|plugins| is_object(plugins))
        .and_then(|plugins| plugins.get(SERVER))
        .filter(|record| is_object(record))
        .cloned())
}

fn installed_from(record: Option<&Json>) -> Option<String> {
    let source = record?.get("source").filter(|source| is_object(source))?;
    Some(crate::fleet::view::text(source.get("path")))
}

/// whether two paths name the same file, so Muse's canonical /private/tmp matches /tmp
pub fn same_path(a: Option<&str>, b: &str) -> bool {
    let Some(a) = a else {
        return false;
    };
    a == b
        || matches!(
            (std::fs::canonicalize(a), std::fs::canonicalize(b)),
            (Ok(one), Ok(other)) if one == other
        )
}

/// whether Muse still holds some of the scp plugin's hooks for review: a headless muse exec runs none of those
fn muse_review_needed(cli: &str, env: &Env) -> bool {
    let argv: Vec<String> = [cli, "plugins", "inspect", SERVER, "--json"]
        .iter()
        .map(|w| (*w).to_owned())
        .collect();
    let RunResult { output, .. } = run_command(&argv, env, None);
    Json::parse(output.as_bytes())
        .and_then(|report| report.get("runtime_capabilities").cloned())
        .is_some_and(|caps| {
            caps.items().iter().any(|cap| {
                is_object(cap) && cap.get("status").and_then(Json::as_str) == Some("review_needed")
            })
        })
}

pub fn plugin_dir(manifest: &str) -> String {
    dirname(&dirname(manifest))
}

fn hook_message(error: &HookError) -> String {
    error.message().to_owned()
}

fn hooked(harness: &str) -> Option<&'static str> {
    HOOKED.iter().find(|kind| **kind == harness).copied()
}

pub fn plan_hooks(plan: &mut Plan, harness: &'static str, ctx: &Ctx) -> Result<(), String> {
    let (env, cwd, now_s) = (&ctx.env, ctx.cwd.as_str(), ctx.now_s);
    let kind = if harness == "grok" {
        if ctx.found.contains_key("claude") {
            plan.note(
                harness,
                "hooks: Grok runs the Claude Code hooks from ~/.claude/settings.json and labels them grok",
            );
            return Ok(());
        }
        "claude"
    } else {
        match hooked(harness) {
            Some(kind) => kind,
            None => return Ok(()),
        }
    };
    let file = hooks_target(kind, "user", env, cwd);
    let had = holds_stops(kind, &file);
    let block_stop = ctx.block_stop || had;
    let launch = HookLaunch {
        launcher: ctx
            .hook_launch
            .clone()
            .filter(|_| kind == "claude" || kind == "codex"),
        native: ctx.native.clone(),
    };
    plan.hooks.insert(
        harness,
        HookTarget {
            kind,
            file: file.clone(),
            block_stop,
            launch: launch.clone(),
        },
    );
    if kind == "claude" || kind == "codex" {
        let others = if kind == "claude" {
            vec![
                hooks_target("claude", "local", env, cwd),
                hooks_target("claude", "project", env, cwd),
            ]
        } else {
            vec![hooks_target("codex", "project", env, cwd)]
        };
        for (at, other) in others.iter().enumerate() {
            if !others[..at].contains(other)
                && *other != file
                && has_our_hooks(other, &launcher_prefixes(&launch))
            {
                plan.note(
                    harness,
                    format!(
                        "hooks: warning, {other} already runs the {CLI_NAME} hooks: in that project every event reports twice; remove them there"
                    ),
                );
            }
        }
    }
    if let Some(blocked) = link_problem(&file, false) {
        plan.problem(harness, format!("hooks: skipped, {blocked}"));
        return Ok(());
    }
    for client in gone_clients(kind, &resolved(&file)?) {
        plan.note(harness, format!("hooks: {}", gone_client_line(&client)));
    }
    let content = match desired_hooks(kind, &file, block_stop, &launch) {
        Ok(content) => content,
        Err(error) => {
            plan.problem(
                harness,
                format!("hooks: skipped, {file} is unreadable ({})", error.message()),
            );
            return Ok(());
        }
    };
    let held = if had && !ctx.block_stop {
        format!(" (it keeps {BLOCK_STOP}, which the file has)")
    } else if ctx.block_stop && !had {
        format!(", with {BLOCK_STOP}")
    } else {
        String::new()
    };
    let manifest: Option<Change> = (!has_hooks(kind, &file, &ctx.launch()))
        .then(|| remember(added_item(harness, "hooks", &file)));
    if kind == "muse" {
        let dir = plugin_dir(&file);
        let record = muse_installed(env).ok().flatten();
        let from = installed_from(record.as_ref());
        let current = match &content {
            Some(content) => content.clone(),
            None => read_text(&resolved(&file)?)?,
        };
        let disabled = record
            .as_ref()
            .is_some_and(|r| r.get("enabled") == Some(&Json::Bool(false)));
        let install = content.is_some()
            || !same_path(from.as_deref(), &dir)
            || record
                .as_ref()
                .and_then(|r| r.get("manifest_sha256"))
                .and_then(Json::as_str)
                != Some(sha256(&current).as_str());
        let cli = ctx.found["muse"].clone();
        let review = install || muse_review_needed(&cli, env);
        if !install && !disabled && !review {
            plan.note(harness, format!("hooks: up to date in {file}{held}"));
            return Ok(());
        }
        let command = |words: &[&str]| -> Vec<String> {
            std::iter::once(cli.clone())
                .chain(words.iter().map(|w| (*w).to_owned()))
                .collect()
        };
        let mut commands = Vec::new();
        if install {
            commands.push(command(&["plugins", "install", &dir, "--scope", "user"]));
        }
        if disabled {
            commands.push(command(&["plugins", "enable", SERVER]));
        }
        if review {
            commands.push(command(&["plugins", "approve", SERVER]));
        }
        let head = if install {
            let replacing = match &from {
                Some(from) if !same_path(Some(from), &dir) => {
                    format!(", replacing the scp plugin installed from {from}")
                }
                _ => String::new(),
            };
            format!(
                "{} the {CLI_NAME} plugin {file}{held}{replacing}{}",
                if content.is_some() {
                    "write"
                } else {
                    "install"
                },
                if disabled {
                    ", and enable it, which Muse has disabled"
                } else {
                    ""
                }
            )
        } else if disabled {
            format!("enable the {CLI_NAME} plugin {file}, which Muse has disabled")
        } else {
            format!(
                "approve the hooks of the {CLI_NAME} plugin {file}, which Muse holds for review"
            )
        };
        let mut lines = vec![head];
        lines.extend(commands.iter().map(|argv| shown(argv)));
        if review {
            lines.push(
                "approves its hooks: a headless muse exec runs no hook Muse holds for review"
                    .into(),
            );
        }
        let (target, run_env) = (file.clone(), env.clone());
        let landed_file = file.clone();
        plan.add(Step {
            harness,
            label: "hooks",
            file: file.clone(),
            plan: lines,
            apply: Box::new(move || {
                let next = if install {
                    desired_hooks(kind, &target, block_stop, &launch)
                        .map_err(|error| hook_message(&error))?
                } else {
                    None
                };
                let saved = match next {
                    Some(next) => write_file(&target, &next, now_s, hook_write())?,
                    None => None,
                };
                for argv in &commands {
                    let result = run_command(argv, &run_env, None);
                    if result.code != 0 {
                        return Err(format!(
                            "muse plugins {} exited {}: {}",
                            argv[2],
                            result.code,
                            last_line(&result.output)
                        ));
                    }
                }
                Ok(saved)
            }),
            manifest,
            landed: Some(Box::new(move || {
                resolved(&landed_file)
                    .is_ok_and(|path| exists(&path))
                    .then(|| "the plugin it wrote".to_owned())
            })),
        });
        return Ok(());
    }
    if content.as_deref().is_none_or(str::is_empty) {
        plan.note(harness, format!("hooks: up to date in {file}{held}"));
        return Ok(());
    }
    let what = if kind == "opencode" {
        format!("write the {CLI_NAME} plugin {file}")
    } else {
        format!("merge the {CLI_NAME} hooks into {file}")
    };
    let why = if harness == "grok" {
        " (Grok runs the Claude Code hooks; claude is not installed)"
    } else if kind == "codex" {
        " (Codex runs them after you review them in /hooks)"
    } else {
        ""
    };
    let target = file.clone();
    plan.add(Step {
        harness,
        label: "hooks",
        file,
        plan: vec![format!("{what}{why}{held}")],
        apply: Box::new(move || {
            match desired_hooks(kind, &target, block_stop, &launch)
                .map_err(|error| hook_message(&error))?
            {
                Some(next) => write_file(&target, &next, now_s, hook_write()),
                None => Ok(None),
            }
        }),
        manifest,
        landed: None,
    });
    Ok(())
}

fn hook_write() -> WriteOptions {
    WriteOptions {
        mode: 0o644,
        ..WriteOptions::default()
    }
}

pub fn plan_unhooks(plan: &mut Plan, harness: &'static str, ctx: &Ctx) -> Result<(), String> {
    let kind = if harness == "grok" {
        "claude"
    } else {
        match hooked(harness) {
            Some(kind) => kind,
            None => return Ok(()),
        }
    };
    let file = hooks_target(kind, "user", &ctx.env, &ctx.cwd);
    let items: Vec<Json> = ctx
        .added
        .iter()
        .filter(|item| {
            let owner = item_harness(item);
            item_kind(item) == "hooks"
                && if kind == "claude" {
                    owner == "claude" || owner == "grok"
                } else {
                    owner == harness
                }
        })
        .cloned()
        .collect();
    if harness == "grok" && !items.is_empty() {
        if ctx.wanted.contains(&"claude") {
            return Ok(());
        }
        if ctx.found.contains_key("claude") {
            plan.note(
                harness,
                format!(
                    "hooks: keeps the hooks in {file}, which Claude Code runs too; undo them with --harness claude"
                ),
            );
            return Ok(());
        }
    }
    if items.is_empty() {
        if harness != "grok" && has_hooks(kind, &file, &ctx.launch()) {
            plan.note(
                harness,
                format!("hooks: keeps the hooks in {file}, which setup did not add"),
            );
        }
        return Ok(());
    }
    let mut paths: Vec<&str> = Vec::new();
    for item in &items {
        if !paths.contains(&item_file(item)) {
            paths.push(item_file(item));
        }
    }
    for path in paths {
        let of_path: Vec<Json> = items
            .iter()
            .filter(|item| item_file(item) == path)
            .cloned()
            .collect();
        plan_unhook(plan, harness, kind, path, of_path, ctx)?;
    }
    Ok(())
}

fn plan_unhook(
    plan: &mut Plan,
    harness: &'static str,
    kind: &'static str,
    file: &str,
    items: Vec<Json>,
    ctx: &Ctx,
) -> Result<(), String> {
    let now_s = ctx.now_s;
    let target = match resolved(file) {
        Ok(target) => target,
        Err(error) => {
            plan.problem(harness, format!("hooks: skipped, {error}"));
            return Ok(());
        }
    };
    let forgotten: Change = Rc::new(move |added| {
        added
            .into_iter()
            .filter(|other| !items.iter().any(|item| same_item(item, other)))
            .collect()
    });
    let gone = |lines: Vec<String>, forgotten: &Change| Step {
        harness,
        label: "hooks",
        file: file.to_owned(),
        plan: lines,
        apply: no_action(),
        manifest: Some(forgotten.clone()),
        landed: None,
    };
    let is_gone = format!("forget {file}, which is gone");
    let remove_file = |target: &str| -> Apply {
        let target = target.to_owned();
        Box::new(move || {
            let saved = backup(&target, now_s)?;
            std::fs::remove_file(&target).map_err(fs_error("unlink", &target))?;
            Ok(Some(saved))
        })
    };
    if kind == "muse" {
        let cli = ctx.found.get("muse").cloned();
        let record = match muse_installed(&ctx.env) {
            Ok(record) => record,
            Err(error) => {
                plan.problem(
                    harness,
                    format!(
                        "hooks: skipped, {} is unreadable ({error})",
                        muse_installed_file(&ctx.env)
                    ),
                );
                return Ok(());
            }
        };
        let installed = same_path(
            installed_from(record.as_ref()).as_deref(),
            &plugin_dir(file),
        );
        if !exists(&target) && !installed {
            plan.add(gone(vec![is_gone], &forgotten));
            return Ok(());
        }
        let remove = match (installed, cli) {
            (true, None) => {
                plan.problem(
                    harness,
                    "hooks: Muse still has the scp plugin, and muse is not installed to remove it",
                );
                return Ok(());
            }
            (true, Some(cli)) => Some(vec![
                cli,
                "plugins".to_owned(),
                "remove".to_owned(),
                SERVER.to_owned(),
            ]),
            (false, _) => None,
        };
        let mut lines = vec![format!("remove the {CLI_NAME} plugin {file}")];
        lines.extend(remove.iter().map(|argv| shown(argv)));
        let (env, delete, path) = (ctx.env.clone(), remove_file(&target), target.clone());
        plan.add(Step {
            harness,
            label: "hooks",
            file: file.to_owned(),
            plan: lines,
            apply: Box::new(move || {
                if let Some(argv) = &remove {
                    let result = run_command(argv, &env, None);
                    if result.code != 0 {
                        return Err(format!(
                            "muse plugins remove exited {}: {}",
                            result.code,
                            last_line(&result.output)
                        ));
                    }
                }
                if !exists(&path) {
                    return Ok(None);
                }
                delete()
            }),
            manifest: Some(forgotten),
            landed: None,
        });
        return Ok(());
    }
    if !exists(&target) {
        plan.add(gone(vec![is_gone], &forgotten));
        return Ok(());
    }
    if kind == "opencode" {
        let text = match read_text(&target) {
            Ok(text) => text,
            Err(error) => {
                plan.problem(
                    harness,
                    format!("hooks: skipped, {file} is unreadable ({error})"),
                );
                return Ok(());
            }
        };
        let plugin = text.starts_with(OPENCODE_MARK)
            && text.split(line_end).any(|line| {
                line == "const BLOCK_STOP = true" || line == "const BLOCK_STOP = false"
            });
        if !plugin {
            plan.note(
                harness,
                format!("hooks: {file} is not a {CLI_NAME} plugin any more; left in place"),
            );
            return Ok(());
        }
        plan.add(Step {
            harness,
            label: "hooks",
            file: file.to_owned(),
            plan: vec![format!("remove the plugin file {file}")],
            apply: remove_file(&target),
            manifest: Some(forgotten),
            landed: None,
        });
        return Ok(());
    }
    let prefixes = launcher_prefixes(&ctx.launch());
    let edit: Edit = Rc::new(move |config: &Json| {
        if kind == "agy" {
            let Json::Obj(entries) = config else {
                return Ok(None);
            };
            if config.get(AGY_HOOK_SET).is_none() {
                return Ok(None);
            }
            return Ok(Some(Json::Obj(
                entries
                    .iter()
                    .filter(|(key, _)| key != AGY_HOOK_SET)
                    .cloned()
                    .collect(),
            )));
        }
        let Some(hooks) = config.get("hooks").filter(|hooks| is_object(hooks)) else {
            return Ok(None);
        };
        mergeable(config).map_err(|error| hook_message(&error))?;
        let merged = merge_hooks(config, &Json::Obj(Vec::new()), &prefixes)?;
        let same = merged.get("hooks").map(Json::compact) == Some(hooks.compact());
        Ok((!same).then_some(merged))
    });
    let apply = match json_edit(file, edit, now_s) {
        Ok(apply) => apply,
        Err(error) => {
            plan.problem(
                harness,
                format!("hooks: skipped, {file} is unreadable ({error})"),
            );
            return Ok(());
        }
    };
    plan.add(match apply {
        Some(apply) => Step {
            harness,
            label: "hooks",
            file: file.to_owned(),
            plan: vec![format!("remove the {CLI_NAME} hooks from {file}")],
            apply,
            manifest: Some(forgotten),
            landed: None,
        },
        None => gone(
            vec![format!("forget {file}, which has no {CLI_NAME} hooks left")],
            &forgotten,
        ),
    });
    Ok(())
}

pub fn plan_unmount(plan: &mut Plan, harness: &'static str, ctx: &Ctx) {
    let now_s = ctx.now_s;
    let cli = ctx.found.get(harness).cloned();
    let item = ctx
        .added
        .iter()
        .find(|other| item_harness(other) == harness && item_kind(other) == "mcp")
        .cloned();
    let file = item.as_ref().map_or_else(
        || mcp_file(harness, &ctx.env),
        |item| item_file(item).to_owned(),
    );
    let entry = match mounted_entry(harness, &file) {
        Ok(entry) => entry,
        Err(error) => {
            plan.problem(
                harness,
                format!("mcp: skipped, {file} is unreadable ({error})"),
            );
            return;
        }
    };
    let Some(item) = item else {
        if entry.is_some() {
            plan.note(
                harness,
                format!("mcp: keeps the {SERVER} in {file}, which setup did not add"),
            );
        }
        return;
    };
    if entry.is_none() {
        plan.add(Step {
            harness,
            label: "mcp",
            file: file.clone(),
            plan: vec![format!("forget {SERVER} in {file}, which is gone")],
            apply: no_action(),
            manifest: Some(forget(item)),
            landed: None,
        });
        return;
    }
    let by_edit = harness == "opencode" || harness == "muse";
    if !by_edit && cli.is_none() {
        plan.problem(
            harness,
            format!(
                "mcp: {file} still mounts {SERVER}, and {harness} is not installed to remove it; remove it by hand"
            ),
        );
        return;
    }
    if let Some(cli) = cli.filter(|_| !by_edit) {
        let mut command = vec![cli, "mcp".to_owned(), "remove".to_owned()];
        if harness == "claude" || harness == "grok" {
            command.extend(["--scope".to_owned(), "user".to_owned()]);
        }
        command.push(SERVER.to_owned());
        let lines = vec![format!("remove {SERVER} from {file}"), shown(&command)];
        let (env, target) = (ctx.env.clone(), file.clone());
        plan.add(Step {
            harness,
            label: "mcp",
            file,
            plan: lines,
            apply: Box::new(move || {
                run_editing(&target, now_s, &env, std::slice::from_ref(&command), &[])
            }),
            manifest: Some(forget(item)),
            landed: None,
        });
        return;
    }
    let key = if harness == "opencode" {
        "mcp"
    } else {
        "mcpServers"
    };
    let edit: Edit = Rc::new(move |config: &Json| {
        let mut next = config.clone();
        let Some(Json::Obj(servers)) = config.get(key) else {
            return Ok(None);
        };
        let rest = servers
            .iter()
            .filter(|(name, _)| name != SERVER)
            .cloned()
            .collect();
        next.set(key, Json::Obj(rest));
        Ok(Some(next))
    });
    match json_edit(&file, edit, now_s) {
        Ok(Some(apply)) => plan.add(Step {
            harness,
            label: "mcp",
            file: file.clone(),
            plan: vec![format!("remove {key}.{SERVER} from {file}")],
            apply,
            manifest: Some(forget(item)),
            landed: None,
        }),
        Ok(None) => {}
        Err(error) => plan.problem(harness, format!("mcp: skipped, {file}: {error}")),
    }
}
