import { CLI_NAME, LIMITS } from "@scp-dev/core"

export const SPAWN_HELP = `${CLI_NAME} spawn [flags] [--] <harness cmd...>: run a worker agent under you with a relay grant (never printed)

  e.g. ${CLI_NAME} spawn --name rev codex exec "review src/judge.ts, end with your findings"
       ${CLI_NAME} spawn claude -p "list the open TODOs in packages/cli"

  --name N              its address (default <harness>-<5 random characters>)
  --title T             its title until it sets its own (default the prompt's first line)
  --no-push             your stop does not wait on it; its messages and handback still reach you after your tool
                        calls or with another worker's push
  --bg | --fg           --bg (the default in an agent's shell or without a terminal on stdout) returns at once;
                        --fg (the default at a terminal) passes on its output and exit code, as scripts need
  --handback-bytes N    hand back only the last N bytes of its final output (1 to ${LIMITS.handbackBytes})
  --peek local          peekable from its start
  --scope P --rules S --in S --out S --allow S --group G --under EP --ttl S --labels K=V,...
                        its scope and grant, as for ${CLI_NAME} spawn-env (default: no scope, the default reach)
  --via R               start it on another machine through runner R (runners.json, see help --all)
The command starts after -- or at the first word that is not one of these flags.

It returns at once, printing the worker's name and its runner's pid: do not background it (no &, no
run_in_background). A failure before the harness starts (bad flags, a refused grant, no such harness) fails the
spawn itself. Your stop waits for the worker's messages (hooks install --push-wait, default 600 s).
Handback: when the harness exits you get its exit code and its reply, cleaned and redacted (a claude -p worker:
all its replies since its prompt, from its transcript; other harnesses: their final output), and each of your
messages it never applied as steer not applied: <text>. A worker that never joined or exited non-zero also hands
back its last ${LIMITS.stderrBytes / 1024} KB of stderr.
Steer: ${CLI_NAME} send <name> <text>; a claude -p or codex exec prompt gets a note naming you and your steer key.
A codex exec worker that exited before a late steer is resumed with it (codex exec resume, at most twice).
A codex exec, agy -p, grok -p or muse exec worker stays resumable: a message resumes its session (--idle S, detached
600 s, then one with a parent hibernates unless --no-durable; ${CLI_NAME} end <name> lets it go).
Harnesses: codex gets -c overrides that hand it the grant (also behind env, timeout, nohup or nice); a ${CLI_NAME}
command from its workspace-write sandbox needs -c sandbox_workspace_write.network_access=true. codex exec
gets --skip-git-repo-check outside a git repo, and with its prompt in argv piped stdin only under --fg. Workers
message with the relay MCP tools (relay_send, relay_inbox, relay_reply). claude -p and grok -p get those tools allowed
unless you pass a permission flag. muse runs with --contributor-mode off unless you pass on. agy needs the allow rules ${CLI_NAME}
setup writes.

Full reference: ${CLI_NAME} help --all.`
