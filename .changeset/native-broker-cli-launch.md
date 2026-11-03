---
"scp-relay": patch
---

A native `swarm daemon` started without `SCP_CLI_ARGV`, as `swarm daemon restart` from a shell is, keeps its built-in wakers and the claude-bg task: it reuses the launch the last broker of the relay directory was given (`cli-argv.json`) while its files exist, else runs the `@scp-dev/cli` its native package is installed beside or inside under `node`, else `swarm` from `PATH`.
