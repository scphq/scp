//! The harness launchers: codex, muse, t3code, agy, grok, opencode and pi, the attribution they share, and how a harness started
//! without the login shell's PATH runs `swarm`.

pub mod attribute;
pub mod channel;
pub mod codex;
pub mod muse;
pub mod t3code;
pub mod ws;

use crate::spawn::argv::executable;
use crate::{Run, Verb};
use scp_mcp::ps::{Env, basename, dirname, join};
use scp_mcp::render::js_space;
use std::io::Read;

pub const VERBS: &[Verb] = &[
    Verb {
        name: "codex",
        run: Run::Words(codex::codex),
    },
    Verb {
        name: "muse",
        run: Run::Words(muse::muse),
    },
    Verb {
        name: "t3code",
        run: Run::Words(t3code::t3code),
    },
];

/// a child's exit as a launcher hands it on: its code, 1 when a signal ended it
pub fn exit_code(status: std::process::ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

/// how a harness started without the login shell's PATH runs `swarm`: `argv` is the prefix, `node` the interpreter when it needed one
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Launcher {
    pub argv: Vec<String>,
    pub node: Option<String>,
    /// why `argv` is the bare binary although it is a node script
    pub problem: Option<String>,
}

fn real(path: &str) -> String {
    std::fs::canonicalize(path)
        .map_or_else(|_| path.to_owned(), |p| p.to_string_lossy().into_owned())
}

/// the first line of `file` when it starts with `#!`
fn shebang(file: &str) -> Option<String> {
    let mut head = Vec::with_capacity(256);
    std::fs::File::open(file)
        .ok()?
        .take(256)
        .read_to_end(&mut head)
        .ok()?;
    let text = String::from_utf8_lossy(&head);
    let rest = text.strip_prefix("#!")?;
    Some(
        rest.split('\n')
            .next()
            .unwrap_or("")
            .trim_matches(js_space)
            .to_owned(),
    )
}

/// a per-shell directory that disappears with the shell (fnm's multishells): `/[^/]*multishells?[^/]*/`
fn transient(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    segments.len() > 2
        && segments[1..segments.len() - 1]
            .iter()
            .any(|segment| segment.contains("multishell"))
}

/// a path that outlives this shell: kept as found (a version manager's shim or Homebrew's link survives upgrades), resolved when it
/// lives in a per-shell directory
fn lasting(path: &str) -> String {
    if transient(path) {
        real(path)
    } else {
        path.to_owned()
    }
}

/// whether a shebang line runs node: `(^|[\s/])node(\s|$)`
fn runs_node(line: &str) -> bool {
    line.match_indices("node").any(|(at, _)| {
        let before = line[..at].chars().next_back();
        let after = line[at + 4..].chars().next();
        before.is_none_or(|c| c == '/' || js_space(c)) && after.is_none_or(js_space)
    })
}

/// the node a shebang names: an absolute interpreter as is, `env node` the one next to `bin` or in its install prefix's bin, else on PATH
fn node_for(
    line: &str,
    bin: &str,
    target: &str,
    which: &dyn Fn(&str) -> Option<String>,
) -> Option<String> {
    let program = line
        .split(js_space)
        .find(|word| !word.is_empty())
        .unwrap_or("");
    if basename(program) != "env" && program.starts_with('/') {
        return executable(program).then(|| program.to_owned());
    }
    let prefix = join(&[&dirname(target), "..", "..", "..", "..", "..", "bin"]);
    for dir in [dirname(bin), prefix] {
        let sibling = join(&[&dir, "node"]);
        if executable(&sibling) {
            return Some(sibling);
        }
    }
    which("node")
}

/// The argv prefix that runs `bin` from a GUI app, whose PATH is not the login shell's: a node script (`#!/usr/bin/env node`, as npm,
/// nvm, fnm and Homebrew install `swarm`) runs as absolute node plus the script's real path; anything else (a native build, a Volta
/// shim) runs as `bin` itself.
pub fn launcher(bin: &str, env: &Env, which: &dyn Fn(&str) -> Option<String>) -> Launcher {
    let target = real(bin);
    let Some(line) = shebang(&target).filter(|line| runs_node(line)) else {
        return Launcher {
            argv: vec![lasting(bin)],
            ..Launcher::default()
        };
    };
    let Some(node) = node_for(&line, bin, &target, which) else {
        let path = env.get("PATH").map_or("", String::as_str);
        return Launcher {
            argv: vec![bin.to_owned()],
            node: None,
            problem: Some(format!(
                "{bin} is a node script and no node was found next to it or on PATH ({path})"
            )),
        };
    };
    let stable = lasting(&node);
    Launcher {
        argv: vec![stable.clone(), target],
        node: Some(stable),
        problem: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    const SCRIPT: &str = "#!/usr/bin/env node\nimport './main.js'\n";

    fn put(file: &str, content: &str) {
        std::fs::create_dir_all(dirname(file)).unwrap();
        std::fs::write(file, content).unwrap();
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn link(target: &str, path: &str) {
        std::fs::create_dir_all(dirname(path)).unwrap();
        symlink(target, path).unwrap();
    }

    struct Root(String);

    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn root() -> Root {
        let dir = std::env::temp_dir().join(format!(
            "launcher-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Root(real(&dir.to_string_lossy()))
    }

    fn none(_: &str) -> Option<String> {
        None
    }

    fn at(home: &str, rel: &str) -> String {
        join(&[home, rel])
    }

    #[test]
    fn an_nvm_install_runs_as_the_node_beside_it_plus_the_real_script() {
        let root = root();
        let home = &root.0;
        let bin = at(home, ".nvm/versions/node/v22.13.0/bin");
        let script = at(
            home,
            ".nvm/versions/node/v22.13.0/lib/node_modules/@scp-dev/cli/dist/cli.js",
        );
        put(&at(&bin, "node"), "#!/bin/sh\n");
        put(&script, SCRIPT);
        link(
            "../lib/node_modules/@scp-dev/cli/dist/cli.js",
            &at(&bin, "swarm"),
        );
        let node = at(&bin, "node");
        assert_eq!(
            launcher(&at(&bin, "swarm"), &Env::new(), &none),
            Launcher {
                argv: vec![node.clone(), script],
                node: Some(node),
                problem: None
            }
        );
    }

    #[test]
    fn a_global_npm_install_takes_node_from_path_and_keeps_homebrews_link() {
        let root = root();
        let home = &root.0;
        let script = at(
            home,
            ".npm-global/lib/node_modules/@scp-dev/cli/dist/cli.js",
        );
        put(&script, SCRIPT);
        link(&script, &at(home, ".npm-global/bin/swarm"));
        put(&at(home, "Cellar/node/22.13.0/bin/node"), "#!/bin/sh\n");
        link(
            &at(home, "Cellar/node/22.13.0/bin/node"),
            &at(home, "homebrew/bin/node"),
        );
        let brewed = at(home, "homebrew/bin/node");
        let which = |name: &str| (name == "node").then(|| brewed.clone());
        assert_eq!(
            launcher(&at(home, ".npm-global/bin/swarm"), &Env::new(), &which).argv,
            [brewed.clone(), script]
        );
    }

    #[test]
    fn an_fnm_multishell_resolves_to_the_installed_node_and_script() {
        let root = root();
        let home = &root.0;
        let install = at(home, ".local/share/fnm/node-versions/v22.13.0/installation");
        let script = at(&install, "lib/node_modules/@scp-dev/cli/dist/cli.js");
        put(&at(&install, "bin/node"), "#!/bin/sh\n");
        put(&script, SCRIPT);
        link(&script, &at(&install, "bin/swarm"));
        link(&install, &at(home, ".local/state/fnm_multishells/123_456"));
        let shell = at(home, ".local/state/fnm_multishells/123_456/bin");
        assert_eq!(
            launcher(&at(&shell, "swarm"), &Env::new(), &none).argv,
            [at(&install, "bin/node"), script]
        );
    }

    #[test]
    fn a_native_binary_or_a_volta_shim_runs_as_itself() {
        let root = root();
        let home = &root.0;
        put(&at(home, ".volta/bin/volta-shim"), "\u{7f}ELF native");
        link(
            &at(home, ".volta/bin/volta-shim"),
            &at(home, ".volta/bin/swarm"),
        );
        assert_eq!(
            launcher(&at(home, ".volta/bin/swarm"), &Env::new(), &none),
            Launcher {
                argv: vec![at(home, ".volta/bin/swarm")],
                ..Launcher::default()
            }
        );
        put(&at(home, "bin/swarm"), "#!/bin/sh\nexec node cli.js\n");
        assert_eq!(
            launcher(&at(home, "bin/swarm"), &Env::new(), &none).argv,
            [at(home, "bin/swarm")]
        );
    }

    #[test]
    fn an_absolute_node_is_used_and_a_lost_script_says_why() {
        let root = root();
        let home = &root.0;
        put(&at(home, "opt/node"), "#!/bin/sh\n");
        put(
            &at(home, "a/swarm"),
            &format!("#!{}\n", at(home, "opt/node")),
        );
        assert_eq!(
            launcher(&at(home, "a/swarm"), &Env::new(), &none).argv,
            [at(home, "opt/node"), at(home, "a/swarm")]
        );
        put(&at(home, "b/swarm"), SCRIPT);
        let env = Env::from([("PATH".to_owned(), "/usr/bin:/bin".to_owned())]);
        let lost = launcher(&at(home, "b/swarm"), &env, &none);
        assert_eq!(lost.argv, [at(home, "b/swarm")]);
        assert!(lost.problem.unwrap().contains("no node was found"));
    }

    #[test]
    fn a_user_link_to_an_nvm_script_finds_the_prefix_node_and_a_multishell_binary_resolves() {
        let root = root();
        let home = &root.0;
        let prefix = at(home, ".nvm/versions/node/v22.13.0");
        let script = at(&prefix, "lib/node_modules/@scp-dev/cli/dist/cli.js");
        put(&at(&prefix, "bin/node"), "#!/bin/sh\n");
        put(&script, SCRIPT);
        link(&script, &at(home, "bin/swarm"));
        assert_eq!(
            launcher(&at(home, "bin/swarm"), &Env::new(), &none).argv,
            [at(&prefix, "bin/node"), script]
        );
        put(&at(home, "native/swarm"), "\u{7f}ELF");
        link(&at(home, "native"), &at(home, "tmp/fnm-multishell-1-2"));
        assert_eq!(
            launcher(
                &at(home, "tmp/fnm-multishell-1-2/swarm"),
                &Env::new(),
                &none
            )
            .argv,
            [at(home, "native/swarm")]
        );
    }

    #[test]
    fn a_shebang_runs_node_only_as_a_word() {
        assert!(runs_node("/usr/bin/env node"));
        assert!(runs_node("/opt/node"));
        assert!(runs_node("node --flag"));
        assert!(!runs_node("/usr/bin/env nodejs"));
        assert!(!runs_node("/bin/sh"));
        assert!(transient("/a/fnm_multishells/1/bin/swarm"));
        assert!(transient("/a/x-multishell-y/swarm"));
        assert!(!transient("/a/b/multishell"));
    }
}
