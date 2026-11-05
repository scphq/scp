//! `swarm setup claude-desktop`: the Claude desktop chat extension, a stored zip of a manifest and a launcher script.

use super::command::{flags, io};
use super::files::fs_error;
use super::harness::{not_on_path, tools};
use super::hook_cmd::shell_quote;
use crate::args::parse_flags;
use crate::fleet::json::Json;
use crate::fleet::mounts::native_mode;
use crate::launch::launcher;
use crate::spawn::argv::{Mount, executable, mount_with, native_swarm, which_on_path};
use crate::term::out;
use crate::{Done, Fail, usage};
use scp_core::protocol::CLI_NAME;
use scp_mcp::ps::{Env, dirname, join};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;

/// the harness label of the Claude desktop app's chat, which mounts the shim through the extension
pub const CHAT_HARNESS: &str = "claude-desktop-chat";
const ENTRY: &str = "server/scp";

/// the extension's manifest (MCPB manifest_version 0.3): a binary server that runs the bundled launcher script with /bin/sh
pub fn mcpb_manifest(version: &str) -> Json {
    let listed = tools()
        .into_iter()
        .map(|(name, description)| {
            Json::object(vec![
                ("name", Json::Str(name)),
                ("description", Json::Str(description)),
            ])
        })
        .collect();
    Json::object(vec![
        ("manifest_version", Json::str("0.3")),
        ("name", Json::str("scp")),
        ("display_name", Json::str("SCP")),
        ("version", Json::str(version)),
        (
            "description",
            Json::str("Message the agents on this machine's SCP relay from Claude chat."),
        ),
        (
            "long_description",
            Json::Str(format!(
                "Mounts the SCP relay MCP server ({CLI_NAME} mcp --harness {CHAT_HARNESS}). Chat is pull only: call relay_inbox to read new messages."
            )),
        ),
        (
            "author",
            Json::object(vec![
                ("name", Json::str("SCP")),
                ("url", Json::str("https://scp.dev")),
            ]),
        ),
        ("homepage", Json::str("https://scp.dev")),
        ("documentation", Json::str("https://scp.dev/docs/harnesses")),
        ("license", Json::str("Apache-2.0")),
        (
            "server",
            Json::object(vec![
                ("type", Json::str("binary")),
                ("entry_point", Json::str(ENTRY)),
                (
                    "mcp_config",
                    Json::object(vec![
                        ("command", Json::str("/bin/sh")),
                        (
                            "args",
                            Json::Arr(vec![Json::Str(format!("${{__dirname}}/{ENTRY}"))]),
                        ),
                        ("env", Json::Obj(Vec::new())),
                    ]),
                ),
            ]),
        ),
        ("tools", Json::Arr(listed)),
        (
            "compatibility",
            Json::object(vec![("platforms", Json::Arr(vec![Json::str("darwin")]))]),
        ),
    ])
}

/// a shell line that execs the native `swarm` of `mount` with its variables and `rest` while the binary is executable, else nothing
pub fn native_exec_line(mount: Option<&Mount>, rest: &str) -> String {
    let Some(mount) = mount.filter(|m| m.native) else {
        return String::new();
    };
    let bin = shell_quote(&mount.argv[0]);
    let vars: Vec<String> = mount
        .env
        .iter()
        .map(|(key, value)| format!("{key}={}", shell_quote(value)))
        .collect();
    let export = if vars.is_empty() {
        String::new()
    } else {
        format!("export {}; ", vars.join(" "))
    };
    format!("if [ -x {bin} ]; then {export}exec {bin} {rest}; fi\n")
}

fn quoted(words: &[String]) -> String {
    words
        .iter()
        .map(|w| shell_quote(w))
        .collect::<Vec<_>>()
        .join(" ")
}

/// the launcher script the manifest runs: the shim by absolute paths, so the app's PATH does not matter; the native server first when
/// `native` names one
pub fn mcpb_launcher(launch: &[String], native: Option<&Mount>) -> String {
    let words = quoted(&chat_words());
    format!(
        "#!/bin/sh\n{}exec {} {words}\n",
        native_exec_line(native, &words),
        quoted(launch)
    )
}

fn chat_words() -> Vec<String> {
    ["mcp", "--harness", CHAT_HARNESS]
        .iter()
        .map(|w| (*w).to_owned())
        .collect()
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                0xedb8_8320 ^ (crc >> 1)
            } else {
                crc >> 1
            };
        }
    }
    crc ^ 0xffff_ffff
}

/// one file of a [`zip`]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipEntry {
    pub path: String,
    pub data: Vec<u8>,
    pub mode: u32,
}

/// a stored (uncompressed) zip with Unix modes and a fixed timestamp, so the same input builds the same bytes
pub fn zip(entries: &[ZipEntry]) -> Vec<u8> {
    let mut locals = Vec::new();
    let mut centrals = Vec::new();
    for entry in entries {
        let name = entry.path.as_bytes();
        let crc = crc32(&entry.data);
        let size = entry.data.len() as u32;
        let offset = locals.len() as u32;
        let common = |out: &mut Vec<u8>| {
            out.extend(20_u16.to_le_bytes());
            out.extend(0x0800_u16.to_le_bytes());
            out.extend(0_u16.to_le_bytes());
            out.extend(0_u16.to_le_bytes());
            out.extend(0x21_u16.to_le_bytes());
            out.extend(crc.to_le_bytes());
            out.extend(size.to_le_bytes());
            out.extend(size.to_le_bytes());
            out.extend((name.len() as u16).to_le_bytes());
        };
        locals.extend(0x0403_4b50_u32.to_le_bytes());
        common(&mut locals);
        locals.extend(0_u16.to_le_bytes());
        locals.extend(name);
        locals.extend(&entry.data);
        centrals.extend(0x0201_4b50_u32.to_le_bytes());
        centrals.extend(((3_u16 << 8) | 20).to_le_bytes());
        common(&mut centrals);
        centrals.extend([0_u8; 8]);
        centrals.extend(((0o100000 | entry.mode) << 16).to_le_bytes());
        centrals.extend(offset.to_le_bytes());
        centrals.extend(name);
    }
    let offset = locals.len() as u32;
    let directory = centrals.len() as u32;
    let mut bytes = locals;
    bytes.append(&mut centrals);
    bytes.extend(0x0605_4b50_u32.to_le_bytes());
    bytes.extend([0_u8; 4]);
    bytes.extend((entries.len() as u16).to_le_bytes());
    bytes.extend((entries.len() as u16).to_le_bytes());
    bytes.extend(directory.to_le_bytes());
    bytes.extend(offset.to_le_bytes());
    bytes.extend([0_u8; 2]);
    bytes
}

/// the .mcpb bytes for a shim run by `launch`, or by the native server `native` names while it is there
pub fn mcpb_bundle(launch: &[String], version: &str, native: Option<&Mount>) -> Vec<u8> {
    zip(&[
        ZipEntry {
            path: "manifest.json".into(),
            data: format!("{}\n", mcpb_manifest(version).pretty()).into_bytes(),
            mode: 0o644,
        },
        ZipEntry {
            path: ENTRY.into(),
            data: mcpb_launcher(launch, native).into_bytes(),
            mode: 0o755,
        },
    ])
}

/// under `SCP_NATIVE=1` or `mcp`, the native mount of `swarm mcp <words>` a host-path launcher runs; a missing native `swarm` is noted
/// and None
pub fn native_server_mount(launch: &[String], words: &[String], env: &Env) -> Option<Mount> {
    let given = env.get("SCP_NATIVE").map(String::as_str);
    if native_mode(given) == "off" {
        return None;
    }
    let Some(bin) = native_swarm(env) else {
        out(&format!(
            "! SCP_NATIVE={} but no native swarm {} (install the native package for this platform or set SCP_SWARM_BIN): it runs {CLI_NAME} mcp through node",
            given.unwrap_or_default(),
            crate::VERSION
        ));
        return None;
    };
    Some(mount_with(Some(&bin), launch, words, env))
}

/// what `setup claude-desktop` is asked for
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DesktopOptions {
    pub out: Option<String>,
    pub open: bool,
    pub bin: Option<String>,
}

/// the options, or None for `--help`
pub fn parse_claude_desktop_args(args: &[String]) -> Result<Option<DesktopOptions>, Fail> {
    let parsed = parse_flags(
        args,
        &flags(&[("out", true), ("open", false), ("bin", true)]),
    )
    .map_err(usage)?;
    if parsed.on("help") {
        return Ok(None);
    }
    Ok(Some(DesktopOptions {
        out: parsed.text("out").map(str::to_owned),
        open: parsed.on("open"),
        bin: parsed.text("bin").map(str::to_owned),
    }))
}

fn default_mcpb_file(env: &Env) -> String {
    join(&[&super::harness::config_home(env), "scp", "scp.mcpb"])
}

/// `swarm setup claude-desktop`: builds the extension and says how to install it, or opens it with --open
pub fn claude_desktop_setup(options: &DesktopOptions, env: &Env) -> Done {
    let which = |name: &str| which_on_path(name, env);
    let Some(bin) = options.bin.clone().or_else(|| which(CLI_NAME)) else {
        return Err(usage(not_on_path()));
    };
    if !bin.starts_with('/') {
        return Err(usage(format!(
            "--bin takes an absolute path to the {CLI_NAME} binary"
        )));
    }
    if !executable(&bin) {
        return Err(usage(format!("{bin} is not an executable file")));
    }
    let file = options
        .out
        .clone()
        .unwrap_or_else(|| default_mcpb_file(env));
    if !file.starts_with('/') || !file.ends_with(".mcpb") {
        return Err(usage("--out takes an absolute path ending in .mcpb"));
    }
    let launch = launcher(&bin, env, &which);
    if let Some(problem) = &launch.problem {
        out(&format!("! {problem}: the extension may not start"));
    }
    let words: Vec<String> = chat_words()[1..].to_vec();
    let native = native_server_mount(&launch.argv, &words, env);
    let dir = dirname(&file);
    std::fs::create_dir_all(&dir).map_err(|e| io(fs_error("mkdir", &dir)(e)))?;
    let temp = format!("{file}.tmp-{}", std::process::id());
    let bundle = mcpb_bundle(&launch.argv, crate::VERSION, native.as_ref());
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o644)
        .open(&temp)
        .and_then(|mut handle| handle.write_all(&bundle))
        .map_err(|e| io(fs_error("open", &temp)(e)));
    written?;
    std::fs::rename(&temp, &file).map_err(|e| io(fs_error("rename", &temp)(e)))?;
    out(&format!("wrote {file}"));
    if let Some(native) = &native {
        let mode = native
            .env
            .iter()
            .find(|(key, _)| key == "SCP_NATIVE")
            .map_or("", |(_, value)| value.as_str());
        out(&format!(
            "  runs: {} (SCP_NATIVE={mode}), while it is there",
            quoted(&native.argv)
        ));
    }
    let mut runs = launch.argv.clone();
    runs.extend(chat_words());
    out(&format!(
        "  {}runs: {}",
        if native.is_some() { "else " } else { "" },
        quoted(&runs)
    ));
    out("  chat is pull only: the model reads new relay messages when it calls relay_inbox");
    if options.open {
        let code = std::process::Command::new("open")
            .arg(&file)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(1);
        if code != 0 {
            out(&format!(
                "! open {file} exited {code}: open it from Finder instead"
            ));
            return Ok(1);
        }
        out("opened it: confirm the install in Claude");
        return Ok(0);
    }
    out(&format!(
        "install: double-click it in Finder, or run open {} (or {CLI_NAME} setup claude-desktop --open)",
        shell_quote(&file)
    ));
    out("rebuild it after moving or upgrading node or swarm");
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_crc_is_the_zip_one() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn a_zip_lays_out_its_records_in_order() {
        let bytes = zip(&[ZipEntry {
            path: "a".into(),
            data: b"hi".to_vec(),
            mode: 0o644,
        }]);
        assert_eq!(&bytes[..4], b"PK\x03\x04");
        assert_eq!(&bytes[31..33], b"hi");
        assert_eq!(&bytes[33..37], b"PK\x01\x02");
        assert_eq!(&bytes[bytes.len() - 22..bytes.len() - 18], b"PK\x05\x06");
        assert_eq!(bytes.len(), 30 + 1 + 2 + 46 + 1 + 22);
    }
}
