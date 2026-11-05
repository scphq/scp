//! `swarm setup --cowork`: the Cowork plugin, as a directory and a zip in the relay's state.

use super::command::io;
use super::desktop::{ZipEntry, native_exec_line, native_server_mount, zip};
use super::files::{fs_error, make_temp_dir};
use super::harness::{Which, not_on_path};
use super::hook_cmd::{HookLaunch, HookOptions, hook_entries, shell_quote};
use crate::fleet::json::Json;
use crate::launch::launcher;
use crate::spawn::argv::{Mount, executable};
use crate::term::out;
use crate::{Done, usage};
use scp_core::protocol::CLI_NAME;
use scp_mcp::identity::relay_dir;
use scp_mcp::ps::{Env, dirname, join};

/// the npx package spec a cloud container runs, pinned to this build
pub fn pinned_cli() -> String {
    format!("@scp-dev/cli@{}", crate::VERSION)
}

/// runs `argv` when its host paths exist, else the pinned CLI through npx, with the remaining arguments either way; the native server of
/// `native` first while it is there
pub fn plugin_launcher(argv: &[String], native: Option<&Mount>) -> Vec<String> {
    let present = argv
        .iter()
        .map(|path| format!("[ -e {} ]", shell_quote(path)))
        .collect::<Vec<_>>()
        .join(" && ");
    let line = native_exec_line(native, "\"$@\"");
    let first = match line.strip_suffix('\n') {
        Some(line) => format!("{line}; "),
        None => line,
    };
    let quoted = argv
        .iter()
        .map(|w| shell_quote(w))
        .collect::<Vec<_>>()
        .join(" ");
    vec![
        "sh".to_owned(),
        "-c".to_owned(),
        format!(
            "{first}if {present}; then exec {quoted} \"$@\"; fi; exec npx -y {} \"$@\"",
            pinned_cli()
        ),
        CLI_NAME.to_owned(),
    ]
}

fn write_tree(temp: &str, entries: &[ZipEntry], zip_temp: &str) -> Result<(), String> {
    for entry in entries {
        let path = join(&[temp, &entry.path]);
        let dir = dirname(&path);
        std::fs::create_dir_all(&dir).map_err(fs_error("mkdir", &dir))?;
        std::fs::write(&path, &entry.data).map_err(fs_error("open", &path))?;
    }
    std::fs::write(zip_temp, zip(entries)).map_err(fs_error("open", zip_temp))
}

fn swap_in(
    temp: &str,
    target: &str,
    old: &str,
    zip_temp: &str,
    archive: &str,
) -> Result<(), String> {
    match std::fs::rename(target, old) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(fs_error("rename", target)(error)),
    }
    if let Err(error) = std::fs::rename(temp, target) {
        let _ = std::fs::rename(old, target);
        return Err(fs_error("rename", temp)(error));
    }
    std::fs::rename(zip_temp, archive).map_err(fs_error("rename", zip_temp))
}

pub fn cowork_setup(bin: Option<&str>, env: &Env, which: Which) -> Done {
    let found = bin.map(str::to_owned).or_else(|| which(CLI_NAME));
    let Some(bin) = found.filter(|bin| !bin.is_empty()) else {
        return Err(usage(not_on_path()));
    };
    if !bin.starts_with('/') {
        return Err(usage(format!(
            "--bin takes an absolute path to the {CLI_NAME} binary"
        )));
    }
    if !executable(&bin) {
        return Err(usage(format!("--bin {bin} is not an executable file")));
    }
    let launch = launcher(&bin, env, which);
    if let Some(problem) = launch.problem {
        return Err(usage(problem));
    }
    let argv = plugin_launcher(&launch.argv, None);
    let words: Vec<String> = ["--harness", "claude", "--channels", "--cowork-only"]
        .iter()
        .map(|w| (*w).to_owned())
        .collect();
    let native = native_server_mount(&launch.argv, &words, env);
    let full = plugin_launcher(&launch.argv, native.as_ref());
    let strings = |list: &[String]| Json::Arr(list.iter().map(|w| Json::str(w.as_str())).collect());
    let mut args = full[1..].to_vec();
    args.push("mcp".to_owned());
    args.extend(words);
    let files = [
        (
            ".claude-plugin/plugin.json",
            Json::object(vec![
                ("name", Json::str("scp")),
                ("version", Json::str(crate::VERSION)),
                (
                    "description",
                    Json::str("Message agents on the SCP relay from Claude Cowork sessions."),
                ),
                ("homepage", Json::str("https://scp.dev")),
            ]),
        ),
        (
            ".mcp.json",
            Json::object(vec![(
                "mcpServers",
                Json::object(vec![(
                    "scp",
                    Json::object(vec![
                        ("command", Json::str(full[0].as_str())),
                        ("args", strings(&args)),
                    ]),
                )]),
            )]),
        ),
        (
            "hooks/hooks.json",
            Json::object(vec![(
                "hooks",
                hook_entries(
                    "claude",
                    &HookOptions {
                        cowork: true,
                        launch: HookLaunch {
                            launcher: Some(argv),
                            native: None,
                        },
                        ..HookOptions::default()
                    },
                ),
            )]),
        ),
    ];
    let dir = relay_dir(env);
    std::fs::create_dir_all(&dir).map_err(|e| io(fs_error("mkdir", &dir)(e)))?;
    let temp = make_temp_dir(&join(&[&dir, ".cowork-plugin-"])).map_err(io)?;
    let target = join(&[&dir, "cowork-plugin"]);
    let old = format!("{temp}-old");
    let archive = join(&[&dir, "scp-cowork.zip"]);
    let zip_temp = format!("{temp}.zip");
    let entries: Vec<ZipEntry> = files
        .iter()
        .map(|(path, value)| ZipEntry {
            path: (*path).to_owned(),
            data: format!("{}\n", value.pretty()).into_bytes(),
            mode: 0o644,
        })
        .collect();
    let built = write_tree(&temp, &entries, &zip_temp)
        .and_then(|()| swap_in(&temp, &target, &old, &zip_temp, &archive));
    let _ = std::fs::remove_dir_all(&temp);
    let _ = std::fs::remove_dir_all(&old);
    let _ = std::fs::remove_file(&zip_temp);
    built.map_err(io)?;
    out(&format!("wrote {archive}"));
    out("upload it in Claude: Customize, Plugins, Add, Upload plugin");
    let local = native.as_ref().map_or_else(String::new, |native| {
        let mode = native
            .env
            .iter()
            .find(|(key, _)| key == "SCP_NATIVE")
            .map_or("", |(_, value)| value.as_str());
        format!(
            "the native {} mcp (SCP_NATIVE={mode}) while it is there, else ",
            native.argv[0]
        )
    });
    out(&format!(
        "Local sessions run {local}this {CLI_NAME}; cloud sessions run {} through npx; scheduled tasks do not wake.",
        pinned_cli()
    ));
    out("Rerun swarm setup --cowork after moving or upgrading node or swarm to rebuild it.");
    Ok(0)
}
