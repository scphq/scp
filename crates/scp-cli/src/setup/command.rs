//! `swarm setup`: the plan, and with `--write` its application and a check per harness.

use super::files::{exists, fs_error, make_temp_dir, read_json, read_text, rewritable_text};
use super::harness::{
    SETUP_HARNESSES, agy_rules, agy_settings_file, detect_harnesses, detect_t3, manifest_file,
    read_manifest, run_command, setup_mount, shell_words, tilde, write_manifest,
};
use super::hook_cmd::BLOCK_STOP;
use super::hooks_install::{desired_hooks, resolved};
use super::plan::{
    Ctx, Line, Plan, Step, plan_agy_rules, plan_hooks, plan_mount, plan_unhooks, plan_unmount,
    plugin_dir,
};
use super::verify::{agy_rules_present, cache_claude_version, verify_mount, verify_muse_plugin};
use crate::account::relay::{config_file, read_object, write_private_json};
use crate::args::{Opt, Options, parse_flags};
use crate::fleet::json::Json;
use crate::fleet::mounts::native_mode;
use crate::launch::launcher;
use crate::spawn::argv::{executable, native_swarm, which_on_path};
use crate::term::out as print;
use crate::{Call, Done, Fail, usage};
use scp_core::protocol::CLI_NAME;
use scp_mcp::client::CallError;
use scp_mcp::identity::safe_cwd;
use scp_mcp::ps::{Env, capture, join, resolve};
use std::path::Path;
use std::rc::Rc;

const HOOK_VERSION_TIMEOUT_MS: u64 = 2000;
const HOOK_VERSION_MAX_BYTES: usize = 4096;

/// what the flags of `swarm setup` ask for
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SetupOptions {
    pub cowork: bool,
    pub engine: Option<String>,
    pub write: bool,
    pub undo: bool,
    /// --no-hooks: the MCP shim only
    pub no_hooks: bool,
    pub block_stop: bool,
    pub bin: Option<String>,
    pub harness: Option<String>,
    pub join: Option<String>,
}

pub fn io(message: impl Into<String>) -> Fail {
    Fail::Call(CallError::Io(message.into()))
}

fn opt(name: &str, string: bool, short: Option<&str>) -> (String, Opt) {
    (
        name.to_owned(),
        Opt {
            string,
            short: short.map(str::to_owned),
            multiple: false,
        },
    )
}

pub fn flags(names: &[(&str, bool)]) -> Options {
    names
        .iter()
        .map(|(name, string)| opt(name, *string, None))
        .chain([opt("help", false, Some("h"))])
        .collect()
}

/// setup's own flags: --hooks, the default, is accepted and changes nothing
fn parse_setup_args(args: &[String]) -> Result<SetupOptions, Fail> {
    let options = flags(&[
        ("cowork", false),
        ("write", false),
        ("undo", false),
        ("hooks", false),
        ("no-hooks", false),
        ("block-stop-on-unread", false),
        ("bin", true),
        ("engine", true),
        ("harness", true),
        ("join", true),
    ]);
    let parsed = parse_flags(args, &options).map_err(usage)?;
    if parsed.on("help") {
        return Err(Fail::Decline("help".into()));
    }
    let engine = parsed.text("engine");
    if engine.is_some_and(|e| !["auto", "ts", "native"].contains(&e)) {
        return Err(usage("--engine takes auto, ts or native"));
    }
    let join = parsed.text("join");
    if join.is_some_and(|j| j != "auto" && j != "manual") {
        return Err(usage("--join takes auto or manual"));
    }
    if parsed.on("hooks") && parsed.on("no-hooks") {
        return Err(usage(
            "--hooks and --no-hooks contradict each other; the hooks are installed unless --no-hooks",
        ));
    }
    Ok(SetupOptions {
        cowork: parsed.on("cowork"),
        engine: engine.filter(|e| !e.is_empty()).map(str::to_owned),
        write: parsed.on("write"),
        undo: parsed.on("undo"),
        no_hooks: parsed.on("no-hooks"),
        block_stop: parsed.on("block-stop-on-unread"),
        bin: parsed.text("bin").map(str::to_owned),
        harness: parsed.text("harness").map(str::to_owned),
        join: join.map(str::to_owned),
    })
}

/// the `scp-hook` of the native package `exe` runs from, as the TypeScript CLI resolves it; a build outside a package has none. The
/// package is known by its own name, since a symlinked one resolves to a path of any shape
fn packaged_hook(exe: &Path) -> Option<String> {
    let bin = exe.parent()?;
    let manifest = join(&[&bin.parent()?.to_string_lossy(), "package.json"]);
    let name = read_json(&manifest)
        .ok()??
        .get("name")?
        .as_str()?
        .to_owned();
    name.starts_with("@scp-dev/native-")
        .then(|| join(&[&bin.to_string_lossy(), "scp-hook"]))
}

/// `$SCP_HOOK_BIN`, else the `scp-hook` of the native package, when it is an executable file whose `--version` prints this version
fn native_hook(env: &Env) -> Option<String> {
    let bin = match env.get("SCP_HOOK_BIN") {
        Some(given) => resolve(&safe_cwd(), given),
        None => packaged_hook(&std::env::current_exe().ok()?.canonicalize().ok()?)?,
    };
    if !executable(&bin) {
        return None;
    }
    let vars: Vec<(&str, String)> = env.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
    let printed = capture(
        &[bin.as_str(), "--version"],
        Some(vars.as_slice()),
        Some(HOOK_VERSION_TIMEOUT_MS),
        Some(HOOK_VERSION_MAX_BYTES),
    )?;
    (printed == format!("scp-hook {}\n", crate::VERSION)).then_some(bin)
}

/// saves how hooked sessions join the relay, the other keys of the config kept
fn set_join_mode(env: &Env, mode: &str) -> Result<(), Fail> {
    let path = config_file(env, "config.json")?;
    if exists(&path) {
        rewritable_text(&path).map_err(|error| usage(format!("{path}: {error}")))?;
    }
    let mut config = read_object(&path)?.unwrap_or(Json::Obj(Vec::new()));
    config.set("join", Json::str(mode));
    write_private_json(&path, &config)
}

fn now_s() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

fn or_empty(text: Option<&String>) -> &str {
    text.map_or("", String::as_str)
}

/// `swarm setup` with `options`: what it does is printed, its exit code returned
pub fn relay_setup(options: &SetupOptions, env: Env, cwd: &str) -> Done {
    let env = Rc::new(env);
    let version = crate::VERSION;
    let engine = options
        .engine
        .clone()
        .or_else(|| env.get("SCP_ENGINE").cloned())
        .unwrap_or_else(|| "auto".to_owned());
    if !["auto", "ts", "native"].contains(&engine.as_str()) {
        return Err(usage("--engine and SCP_ENGINE take auto, ts or native"));
    }
    let no_native = engine == "ts" || options.undo || options.no_hooks || options.cowork;
    let native = if no_native { None } else { native_hook(&env) };
    if engine == "native"
        && native.is_none()
        && !options.undo
        && !options.no_hooks
        && !options.cowork
    {
        return Err(usage(
            "Native hook client missing, not executable, or version differs from CLI; install the matching native package or set SCP_HOOK_BIN",
        ));
    }
    let which_env = env.clone();
    let which = move |name: &str| which_on_path(name, &which_env);
    if options.cowork {
        if options.undo
            || options.harness.is_some()
            || options.no_hooks
            || options.block_stop
            || options.join.is_some()
        {
            return Err(usage("--cowork takes only --bin and optionally --write"));
        }
        return Err(Fail::Decline("cowork".into()));
    }
    let now = now_s();
    let out = {
        let env = env.clone();
        move |line: &str| print(&tilde(line, &env))
    };
    if let Some(harness) = &options.harness
        && !SETUP_HARNESSES.contains(&harness.as_str())
    {
        return Err(usage(format!(
            "--harness is one of {}",
            SETUP_HARNESSES.join(", ")
        )));
    }
    if options.block_stop && (options.no_hooks || options.undo) {
        return Err(usage(format!(
            "{BLOCK_STOP} goes with the hooks: not with --no-hooks or --undo"
        )));
    }
    if options.join.is_some() && options.undo {
        return Err(usage("--join sets how sessions join: not with --undo"));
    }
    let added = read_manifest(&env).map_err(|error| {
        usage(format!(
            "{}, setup's list of what it added, is unreadable ({error}); fix or remove it",
            manifest_file(&env)
        ))
    })?;
    let on_path = which(CLI_NAME);
    let bin = match (&options.bin, &on_path) {
        (Some(bin), _) => {
            if !bin.starts_with('/') {
                return Err(usage(format!(
                    "--bin takes an absolute path to the {CLI_NAME} binary"
                )));
            }
            if !executable(bin) {
                return Err(usage(format!("--bin {bin} is not an executable file")));
            }
            bin.clone()
        }
        (None, Some(path)) => path.clone(),
        (None, None) if options.undo => CLI_NAME.to_owned(),
        (None, None) => {
            return Err(usage(format!(
                "{CLI_NAME} is not on PATH: pass --bin /absolute/path/to/{CLI_NAME} (the mounts then run that path)"
            )));
        }
    };
    let found = detect_harnesses(&env, &which);
    let wanted: Vec<&'static str> = SETUP_HARNESSES
        .iter()
        .filter(|harness| options.harness.as_deref().is_none_or(|h| h == **harness))
        .copied()
        .collect();
    let selected: Vec<&'static str> = wanted
        .iter()
        .filter(|harness| found.contains_key(*harness))
        .copied()
        .collect();
    let missing: Vec<&str> = wanted
        .iter()
        .filter(|harness| !found.contains_key(*harness))
        .copied()
        .collect();
    out(&format!(
        "{CLI_NAME} setup{}: {}",
        if options.undo { " --undo" } else { "" },
        if options.write {
            "applying"
        } else {
            "dry run, nothing is written (add --write to apply)"
        }
    ));
    let mut hooks = !options.no_hooks;
    let mut unresolved = 0_usize;
    if let Some(mode) = &options.join {
        if options.write {
            set_join_mode(&env, mode)?;
        }
        let how = if mode == "manual" {
            format!(" (a session stays off the relay until it runs {CLI_NAME} join <name>)")
        } else {
            " (every hooked session joins when it starts)".to_owned()
        };
        out(&format!(
            "join: {mode}{how}{}",
            if options.write {
                ""
            } else {
                ", saved with --write"
            }
        ));
    }
    if options.no_hooks {
        out(&format!(
            "hooks: {}",
            if options.undo {
                "kept (--no-hooks)"
            } else {
                "not installed (--no-hooks); only the MCP shim is mounted"
            }
        ));
    }
    let run = {
        let env = env.clone();
        move |argv: &[String]| run_command(argv, &env, None)
    };
    let mounts = launcher(&bin, &env, &which);
    let mut native_server: Option<String> = None;
    let mut hook_launch: Option<Vec<String>> = on_path
        .as_deref()
        .map(|path| launcher(path, &env, &which).argv);
    if !options.undo {
        let how = mounts.node.as_ref().map_or_else(String::new, |node| {
            format!(", run by {node} since it is a node script and a desktop app's PATH may have no node")
        });
        let runs = shell_words(&mounts.argv);
        if options.bin.is_some() {
            out(&format!(
                "mounts run: {runs} (from --bin{how}; they break if that file moves)"
            ));
        } else {
            let target = resolved(&bin).map_err(io)?;
            let by = if mounts.node.is_some() {
                "its real path".to_owned()
            } else if target != bin {
                format!("that path and not its target {target}")
            } else {
                "that path".to_owned()
            };
            out(&format!(
                "mounts run: {runs} ({CLI_NAME} on PATH, by {by}{how}, so a harness started without your PATH finds it)"
            ));
        }
        if let Some(problem) = &mounts.problem {
            out(&format!(
                "! {problem}: a harness started without your PATH may not start the mount"
            ));
        }
        let given = env.get("SCP_NATIVE");
        let mode = native_mode(given.map(String::as_str));
        if mode != "off" {
            let broker = if mode == "all" {
                "the native broker"
            } else {
                "the TypeScript broker"
            };
            let shown = or_empty(given);
            native_server = native_swarm(&env);
            out(&match &native_server {
                Some(server) => format!(
                    "native MCP: the mounts run {server} mcp directly (SCP_NATIVE={shown}, version {version}), told to start {CLI_NAME} as above and {broker}; rerun setup after an upgrade that moves it"
                ),
                None => format!(
                    "! SCP_NATIVE={shown} but no native swarm {version} (install the native package for this platform or set SCP_SWARM_BIN): the mounts run {CLI_NAME} mcp through node"
                ),
            });
        }
        let help_words = ["help".to_owned(), "--all".to_owned()];
        let help_of = |prefix: &[String]| {
            let argv: Vec<String> = prefix.iter().chain(&help_words).cloned().collect();
            run(&argv).output
        };
        let help = help_of(&mounts.argv);
        if !help.contains(&format!("{CLI_NAME} mcp")) {
            out(&format!(
                "! {bin} has no `{CLI_NAME} mcp` (its `help --all` does not list it): update it, or pass --bin with a {CLI_NAME} that has the relay"
            ));
            if options.write {
                return Ok(1);
            }
        }
        if hooks && env.get("SCP_TRANSPORT").map(String::as_str) == Some("cloud") {
            out(&format!(
                "! the hooks report to the local broker, and SCP_TRANSPORT=cloud bypasses it: hooks are skipped; link the broker instead ({CLI_NAME} cloud enable), unset it and rerun"
            ));
            hooks = false;
            unresolved += 1;
        } else if hooks && on_path.is_none() {
            out(&format!(
                "! the hooks run `{CLI_NAME} hook` from PATH, where there is no {CLI_NAME}: hooks are skipped until it is there"
            ));
            hooks = false;
            unresolved += 1;
        } else if let (true, Some(path)) = (hooks, &on_path) {
            let own_help = if options.bin.is_none() {
                help.clone()
            } else {
                help_of(std::slice::from_ref(path))
            };
            if !own_help.contains(&format!("{CLI_NAME} hook")) {
                out(&format!(
                    "! the hooks run `{CLI_NAME} hook` from PATH, and {path} has no `{CLI_NAME} hook`: hooks are skipped until it does"
                ));
                hooks = false;
                unresolved += 1;
            } else {
                let argv = launcher(path, &env, &which).argv;
                if let Some(native) = &native {
                    out(&format!(
                        "native hooks: {native} (version {version}) runs each hook, and a hook runs the command below without it once that file is gone"
                    ));
                }
                out(&format!(
                    "hooks run: {} for claude and codex, whose desktop apps start them without your PATH; {CLI_NAME} from each harness's PATH for the others ({path} here{})",
                    shell_words(&argv),
                    if options.bin.is_some() {
                        ", not --bin"
                    } else {
                        ""
                    }
                ));
                hook_launch = Some(argv);
            }
        }
    }
    let shown_found: Vec<String> = selected
        .iter()
        .map(|harness| format!("{harness} ({})", found[harness]))
        .collect();
    out(&format!(
        "found: {}",
        if shown_found.is_empty() {
            "none".to_owned()
        } else {
            shown_found.join(", ")
        }
    ));
    if !missing.is_empty() {
        out(&format!("not installed: {}", missing.join(", ")));
    }
    if !options.undo
        && let Some(t3) = detect_t3(&env, &which)
    {
        out(&format!(
            "T3 Code ({t3}): its codex and Claude Code sessions use those harnesses' mounts and hooks below, so it needs no setup of its own; {CLI_NAME} t3code --thread <id> wakes a thread"
        ));
    }

    let mut plan = Plan::default();
    let ctx = Ctx {
        env: env.clone(),
        cwd: cwd.to_owned(),
        now_s: now,
        found: found.clone(),
        added,
        wanted: wanted.clone(),
        block_stop: options.block_stop,
        native,
        hook_launch,
    };
    let harnesses = if options.undo { &wanted } else { &selected };
    for harness in harnesses {
        if options.undo {
            plan_unmount(&mut plan, harness, &ctx);
        } else {
            let mount = setup_mount(harness, &mounts.argv, native_server.as_deref(), &env);
            plan_mount(&mut plan, harness, &mount, &ctx).map_err(io)?;
        }
        if *harness == "agy" {
            plan_agy_rules(&mut plan, &ctx, options.undo);
        }
        if hooks {
            if options.undo {
                plan_unhooks(&mut plan, harness, &ctx).map_err(io)?;
            } else {
                plan_hooks(&mut plan, harness, &ctx).map_err(io)?;
            }
        }
    }
    for harness in &wanted {
        let mine: Vec<&Line> = plan
            .lines
            .iter()
            .filter(|(owner, _)| owner == harness)
            .map(|(_, line)| line)
            .collect();
        if !found.contains_key(harness) && mine.is_empty() {
            continue;
        }
        out("");
        out(&format!(
            "{harness}{}:",
            if found.contains_key(harness) {
                ""
            } else {
                " (not installed)"
            }
        ));
        for line in &mine {
            match line {
                Line::Text(text) => out(&format!("  {text}")),
                Line::Step(at) => {
                    let step = &plan.steps[*at];
                    let head = step.plan.first().map_or("", String::as_str);
                    out(&format!("  {}: {head}", step.label));
                    for line in &step.plan[1..] {
                        print(&format!("      {line}"));
                    }
                }
            }
        }
        if options.undo && mine.is_empty() {
            out("  nothing setup added");
        }
    }
    unresolved += plan.problems;
    out("");
    let count = plan.steps.len();
    if count == 0 {
        out(if options.undo {
            "nothing to remove"
        } else {
            "everything is in place; nothing to do"
        });
    } else if !options.write {
        out(&format!(
            "{count} change{} planned; rerun with --write to apply",
            if count == 1 { "" } else { "s" }
        ));
    }
    if unresolved > 0 {
        out(&format!(
            "{unresolved} item{} marked ! {} a fix by hand or a rerun",
            if unresolved == 1 { "" } else { "s" },
            if options.write { "need" } else { "will need" }
        ));
    }
    if !options.write {
        return Ok(0);
    }

    let mut failures = unresolved;
    let mut applied = vec![false; count];
    for (at, step) in plan.steps.iter().enumerate() {
        let done = (step.apply)().and_then(|saved| {
            applied[at] = true;
            if let Some(change) = &step.manifest {
                write_manifest(&env, now, change)?;
            }
            Ok(saved)
        });
        match done {
            Ok(saved) => {
                let backup = saved.map_or_else(String::new, |s| format!(" (backup {s})"));
                out(&format!("{} {}: done{backup}", step.harness, step.label));
            }
            Err(error) => {
                failures += 1;
                let kept = record_landed(step, &env, now);
                let tail = kept.map_or_else(String::new, |what| {
                    format!("; {what} is recorded, so --undo removes it")
                });
                out(&format!(
                    "{} {}: FAILED, {error}{tail}",
                    step.harness, step.label
                ));
            }
        }
    }
    out("");
    out("verify:");
    let mut check = |ok: bool, line: &str| {
        if !ok {
            failures += 1;
        }
        out(&format!("  {line}"));
    };
    let base = join(&[&std::env::temp_dir().to_string_lossy(), "scp-setup-"]);
    let scratch = make_temp_dir(&base).map_err(io)?;
    let neutral = join(&[&scratch, "relay-setup-check"]);
    std::fs::create_dir(&neutral).map_err(|e| io(fs_error("mkdir", &neutral)(e)))?;
    let run_neutral = |argv: &[String]| run_command(argv, &env, Some(&neutral));
    let applied_step = |harness: &str, label: &str| -> Option<&Step> {
        plan.steps
            .iter()
            .enumerate()
            .find(|(at, step)| step.harness == harness && step.label == label && applied[*at])
            .map(|(_, step)| step)
    };
    let verified = (|| -> Result<(), String> {
        for harness in &selected {
            let cli = &found[harness];
            if options.undo {
                if applied_step(harness, "mcp").is_some() {
                    let (ok, line) = verify_mount(harness, cli, &env, &run_neutral, None);
                    check(ok, &format!("{harness}: {line}"));
                }
                if *harness == "muse"
                    && let Some(plugin) = applied_step(harness, "hooks")
                {
                    let dir = plugin_dir(&plugin.file);
                    let (ok, line) = verify_muse_plugin(cli, &dir, &run_neutral, None);
                    check(ok, &format!("muse hooks: {line}"));
                }
                continue;
            }
            let mount = setup_mount(harness, &mounts.argv, native_server.as_deref(), &env);
            let (ok, line) = verify_mount(harness, cli, &env, &run_neutral, Some(&mount));
            check(ok, &format!("{harness}: {line}"));
            if *harness == "agy" {
                let rules = agy_rules();
                let file = agy_settings_file(&env);
                let present = agy_rules_present(&file, &rules);
                check(
                    present == rules.len(),
                    &format!(
                        "agy permissions: {present} of {} relay tool rules in {file}",
                        rules.len()
                    ),
                );
            }
            let Some(target) = plan.hooks.get(harness) else {
                continue;
            };
            let in_place = matches!(
                desired_hooks(target.kind, &target.file, target.block_stop, &target.launch),
                Ok(None)
            );
            check(
                in_place,
                &format!(
                    "{harness} hooks: {} in {}",
                    if in_place { "in place" } else { "missing" },
                    target.file
                ),
            );
            if *harness == "claude" && in_place {
                cache_claude_version(cli, &env, &run_neutral);
            }
            if target.kind == "muse" && in_place {
                let text = resolved(&target.file).and_then(|path| read_text(&path))?;
                let dir = plugin_dir(&target.file);
                let (ok, line) = verify_muse_plugin(cli, &dir, &run_neutral, Some(&text));
                check(ok, &format!("muse hooks: {line}"));
            }
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    verified.map_err(io)?;
    if (0..count).any(|at| applied[at] && plan.steps[at].label == "hooks") {
        out("");
        out("restart sessions started before setup: harnesses read hooks only at session start");
    }
    Ok(i32::from(failures > 0))
}

/// the manifest entry of what a failed step left on disk anyway, naming it
fn record_landed(step: &Step, env: &Env, now: i64) -> Option<String> {
    let change = step.manifest.as_ref()?;
    let kept = step.landed.as_ref()?()?;
    write_manifest(env, now, change).ok()?;
    Some(kept)
}

/// `swarm setup <words>`: the `claude-desktop` extension, else setup itself
pub fn setup(call: &Call, words: &[String]) -> Done {
    let mut env = call.env.clone();
    crate::route::caller_argv(&mut env);
    if words.first().map(String::as_str) == Some("claude-desktop") {
        return Err(Fail::Decline("claude-desktop".into()));
    }
    relay_setup(&parse_setup_args(words)?, env, &safe_cwd())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Root(std::path::PathBuf);

    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_hook_client_is_beside_a_binary_of_the_native_package_whatever_its_path() {
        let root = Root(std::env::temp_dir().join(format!(
            "packaged-hook-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        )));
        let package = |dir: &str, name: &str| {
            let bin = root.0.join(dir).join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            let manifest = Json::object(vec![("name", Json::str(name))]).pretty();
            std::fs::write(root.0.join(dir).join("package.json"), manifest).unwrap();
            bin
        };
        let hook = |bin: &Path| packaged_hook(&bin.join("swarm"));
        for dir in ["node_modules/@scp-dev/native-darwin-arm64", "opt/any-name"] {
            let bin = package(dir, "@scp-dev/native-darwin-arm64");
            let found = bin.join("scp-hook");
            assert_eq!(hook(&bin).as_deref(), found.to_str());
        }
        assert_eq!(hook(&package("other", "@scp-dev/cli")), None);
        assert_eq!(hook(&root.0.join("target/debug")), None);
        assert_eq!(hook(Path::new("/")), None);
    }
}
