//! The words that start the CLI, which the broker's built-in wakers and tasks run.

use std::collections::{BTreeMap, BTreeSet};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::Value;

use crate::wake::cli_argv;

/// the file in the relay directory that keeps the last launch a broker was given
pub const RECORD_FILE: &str = "cli-argv.json";

/// this executable and the CLI verbs it runs natively
pub type NativeVerbs = (PathBuf, BTreeSet<String>);

static NATIVE_VERBS: OnceLock<NativeVerbs> = OnceLock::new();

/// names this executable and the CLI verbs it runs, so built-in wakers and tasks run those on it, with no CLI process per run
pub fn set_native_verbs<S: Into<String>>(exe: PathBuf, verbs: impl IntoIterator<Item = S>) {
    let _ = NATIVE_VERBS.set((exe, verbs.into_iter().map(Into::into).collect()));
}

/// the command that runs CLI `verb`: this executable when it runs the verb, else `cli` followed by it
pub fn verb_command(cli: &[String], verb: &str) -> Vec<String> {
    command_for(NATIVE_VERBS.get(), cli, verb)
}

fn command_for(native: Option<&NativeVerbs>, cli: &[String], verb: &str) -> Vec<String> {
    match native {
        Some((exe, verbs)) if verbs.contains(verb) => {
            vec![exe.to_string_lossy().into_owned(), verb.to_owned()]
        }
        _ => cli.iter().cloned().chain([verb.to_owned()]).collect(),
    }
}

/// `$SCP_CLI_ARGV`, else the launch the last broker of `dir` was given while its files still exist, else the CLI installed beside
/// this executable's native package; None leaves `swarm` on PATH
pub fn cli_launch(env: &BTreeMap<String, String>, dir: &Path) -> Option<Vec<String>> {
    if let Some(words) = cli_argv(env) {
        record(dir, &words);
        return Some(words);
    }
    recorded(dir).or_else(|| {
        let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
        beside_package(&exe, env)
    })
}

fn record(dir: &Path, words: &[String]) {
    let path = dir.join(RECORD_FILE);
    let temp = dir.join(format!("{RECORD_FILE}.{}.tmp", std::process::id()));
    let text = format!("{}\n", Value::from(words.to_vec()));
    let written = std::fs::write(&temp, text)
        .and_then(|()| std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)))
        .and_then(|()| std::fs::rename(&temp, &path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
}

/// the recorded launch, when its program and every absolute path among its words still exist
fn recorded(dir: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(dir.join(RECORD_FILE)).ok()?;
    let words: Vec<String> = serde_json::from_str(&text).ok()?;
    if words.is_empty() || words.iter().any(String::is_empty) || !executable(Path::new(&words[0])) {
        return None;
    }
    words
        .iter()
        .filter(|word| word.starts_with('/'))
        .all(|word| Path::new(word).exists())
        .then_some(words)
}

fn executable(path: &Path) -> bool {
    path.is_absolute()
        && std::fs::metadata(path)
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// `node <cli>/dist/cli.js` for an executable at `<scope>/native-<key>/bin/<name>` of the `@scp-dev` scope, the CLI hoisted beside it
/// or the package it is nested in, with `node` from PATH
pub fn beside_package(exe: &Path, env: &BTreeMap<String, String>) -> Option<Vec<String>> {
    let package = exe
        .parent()
        .filter(|bin| bin.file_name().is_some_and(|name| name == "bin"))?
        .parent()?;
    if !package.file_name()?.to_str()?.starts_with("native-") {
        return None;
    }
    let scope = package
        .parent()
        .filter(|scope| scope.file_name().is_some_and(|name| name == "@scp-dev"))?;
    let nested = scope
        .parent()
        .filter(|modules| {
            modules
                .file_name()
                .is_some_and(|name| name == "node_modules")
        })
        .and_then(Path::parent);
    let cli = [Some(scope.join("cli")), nested.map(Path::to_path_buf)]
        .into_iter()
        .flatten()
        .find(|dir| cli_package(dir))?;
    let node = on_path("node", env)?;
    Some(vec![
        node.to_string_lossy().into_owned(),
        cli.join("dist/cli.js").to_string_lossy().into_owned(),
    ])
}

/// `swarm` on PATH unless it is this executable, which runs no CLI command
pub fn path_cli(env: &BTreeMap<String, String>) -> Option<Vec<String>> {
    let found = on_path(scp_core::protocol::CLI_NAME, env)?;
    let own = std::env::current_exe().ok()?.canonicalize().ok()?;
    (found.canonicalize().ok()? != own).then(|| vec![found.to_string_lossy().into_owned()])
}

fn cli_package(dir: &Path) -> bool {
    let name = std::fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("name").and_then(Value::as_str).map(str::to_owned));
    name.as_deref() == Some("@scp-dev/cli") && dir.join("dist/cli.js").is_file()
}

fn on_path(name: &str, env: &BTreeMap<String, String>) -> Option<PathBuf> {
    env.get("PATH")?
        .split(':')
        .filter(|dir| dir.starts_with('/'))
        .map(|dir| Path::new(dir).join(name))
        .find(|path| executable(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("scp-launch-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn file(path: &Path, text: &str, mode: u32) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    fn cli(dir: &Path) {
        file(
            &dir.join("package.json"),
            r#"{"name":"@scp-dev/cli"}"#,
            0o644,
        );
        file(&dir.join("dist/cli.js"), "", 0o755);
    }

    #[test]
    fn a_verb_this_executable_runs_skips_the_cli() {
        let cli = vec!["node".to_owned(), "/cli.js".to_owned()];
        let native: NativeVerbs = (
            "/bin/swarm".into(),
            BTreeSet::from(["dummy-wake".to_owned()]),
        );
        assert_eq!(
            command_for(Some(&native), &cli, "dummy-wake"),
            vec!["/bin/swarm", "dummy-wake"]
        );
        assert_eq!(
            command_for(Some(&native), &cli, "spawn-wake"),
            vec!["node", "/cli.js", "spawn-wake"]
        );
        assert_eq!(
            command_for(None, &cli, "dummy-wake"),
            vec!["node", "/cli.js", "dummy-wake"]
        );
        set_native_verbs("/bin/swarm".into(), ["__test-verb"]);
        assert_eq!(
            verb_command(&cli, "__test-verb"),
            vec!["/bin/swarm", "__test-verb"]
        );
        assert_eq!(
            crate::wake::Wakers::builtin_for(&cli)["codex-queue"].command,
            vec!["node", "/cli.js", "codex-wake"]
        );
    }

    #[test]
    fn the_cli_beside_the_native_package_runs_under_node_from_path() {
        let root = scratch("beside");
        file(&root.join("tools/node"), "", 0o755);
        let env = BTreeMap::from([(
            "PATH".to_owned(),
            format!("relative:{}", root.join("tools").display()),
        )]);
        let hoisted = root.join("lib/node_modules/@scp-dev");
        let exe = hoisted.join("native-darwin-arm64/bin/swarm");
        assert_eq!(beside_package(&exe, &env), None);
        cli(&hoisted.join("cli"));
        let node = root.join("tools/node").display().to_string();
        assert_eq!(
            beside_package(&exe, &env),
            Some(vec![
                node.clone(),
                hoisted.join("cli/dist/cli.js").display().to_string()
            ])
        );
        let outer = root.join("global/@scp-dev/cli");
        cli(&outer);
        let exe = outer.join("node_modules/@scp-dev/native-linux-x64-gnu/bin/swarm");
        assert_eq!(
            beside_package(&exe, &env),
            Some(vec![node, outer.join("dist/cli.js").display().to_string()])
        );
        assert_eq!(beside_package(&root.join("target/debug/swarm"), &env), None);
        assert_eq!(beside_package(&exe, &BTreeMap::new()), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_given_launch_is_recorded_and_reused_while_its_files_exist() {
        let root = scratch("record");
        let node = root.join("node");
        file(&node, "", 0o755);
        let script = root.join("cli.js");
        file(&script, "", 0o644);
        let words = vec![
            node.display().to_string(),
            "--flag".into(),
            script.display().to_string(),
        ];
        let env = BTreeMap::from([(
            "SCP_CLI_ARGV".to_owned(),
            Value::from(words.clone()).to_string(),
        )]);
        assert_eq!(cli_launch(&env, &root), Some(words.clone()));
        let mode = std::fs::metadata(root.join(RECORD_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(recorded(&root), Some(words));
        std::fs::remove_file(&script).unwrap();
        assert_eq!(recorded(&root), None);
        std::fs::write(root.join(RECORD_FILE), r#"["node","cli.js"]"#).unwrap();
        assert_eq!(recorded(&root), None);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
