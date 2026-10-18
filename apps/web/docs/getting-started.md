# Getting started

The `swarm` CLI is the reference implementation of SCP. It runs a broker on your machine, mounts an MCP server in your harnesses and installs hooks that deliver messages at turn boundaries.

## Install

```sh
npm i -g @scp-dev/cli
swarm --version
```

The broker starts on demand. A swarm on one machine needs no account; sign in to link machines through your org's hub.

## Sign in and link

```sh
swarm up
swarm cloud status
```

`swarm up` logs in if needed, links this machine's broker to the org hub and runs `swarm setup --write`. The login opens the relay's device page in your browser and prints a code. Check that the page shows the same code and approve it. The credential goes in `~/.config/scp/credentials.json`. Run it before you start any agent session: a broker that was already running stays local-only until it exits.

| Where you are | Command |
| --- | --- |
| A desktop with a browser | `swarm up` |
| SSH, a container, no browser | `swarm up --no-browser`, then open the printed URL on any device |
| Headless or ambient, with a token | `swarm up --token scp_t_... [--machine NAME]` |

`--machine` names this machine on the hub, and defaults to the short hostname. `swarm logout` removes the stored credential.

Once linked, agents on your own other devices show up as `me/<machine>/<handle>`, and those on devices other members of the org linked as `<org>/<machine>/<handle>`, for example `scp-dev/teammate-laptop/review`. Either form works when you send to any machine of the org.

## Hooks and MCP

Each harness needs the MCP server (pull: the model calls `relay_send`, `relay_inbox`, `relay_reply`) and the hooks (push: messages enter the model's context after tools, on prompts and at stops). `swarm up` installs both, at user scope, in every installed harness. `swarm setup` prints that plan without applying it.

To install one harness at a time instead:

```sh
swarm hooks install --harness claude            # print the hooks and the file they go in
swarm hooks install --harness claude --write    # merge them in, with a backup
swarm mcp install --harness claude              # print the command that mounts the MCP server
```

`hooks install` takes `claude`, `codex`, `opencode`, `agy` or `muse`, and `--scope project|user|local`. Claude Code defaults to `local` (`.claude/settings.local.json`). `swarm setup --undo` removes what setup added. See [Harnesses](/docs/harnesses) for what each integration does.

## A first swarm

Start a named orchestrator session:

```sh
swarm claude --name lead
```

`swarm claude` starts Claude Code with the scp channel loaded, so peer messages wake it even while it is idle. Its hooks join it to the relay as `me/lead`.

A session that is already running joins from its own shell, so you can tell any session:

```sh
swarm join lead     # put this session on the relay as me/lead
swarm name reviewer # rename it in place later; its mail and threads stay
swarm leave         # take it off the relay; its mail is kept until it joins again
```

`swarm join` works in a session started before the hooks were installed too. With `swarm setup --join manual --write`, sessions stay off the relay until they run `swarm join`; the default, `auto`, joins every hooked session when it starts. `swarm list` shows the live sessions, and `swarm list --all` adds the offline ones.

From the orchestrator's shell, spawn a worker:

```sh
swarm spawn --name parser -- claude -p "Fix the parser tests"
```

`spawn` runs the harness with a grant that places the worker under the orchestrator, with scope `parent`, and returns at once. Without `--name` the worker is `<harness>-<5 random characters>`. From a plain terminal, `spawn` needs a parent: pass `--as lead` to spawn as the orchestrator.

```sh
swarm list --tree                                     # agents nested by parent
swarm send parser "Also cover the empty-input case."  # message the worker
swarm inbox --wait 50                                 # wait for its reply or handback
```

A session nobody titled takes its title from the harness: the name Claude Code or OpenCode gives the session, else the first line of its first prompt. `swarm set-title` replaces it, and an inferred title never overwrites one you set.

An agent's now line (`swarm set-now`, or `relay_set_now` over MCP) is its tl;dr, shown in `swarm list` and on the dashboard. Every 10 prompts without a new one, the prompt hook reminds the agent to refresh it; `SCP_TLDR_EVERY` changes the interval, and 0 turns the reminder off.

When the worker exits you get a handback: its exit code and final output, so it need not report back itself. `swarm status` shows the fleet in short and `swarm watch` tails it live.

While the orchestrator's workers run, its stop hook waits up to 600 s (`--push-wait`) for their next message or handback and continues the turn with it.

## Steer a worker

Only the parent that spawned a worker can steer it. Your messages to it carry a steer key, and the worker's hooks frame them as a new instruction from the source of its task:

```sh
swarm send parser "Skip the fuzz suite, it is flaky on CI."
```

The message reaches the worker after its next tool call. It applies the message before it finishes, and where it conflicts with an earlier instruction, the newer one wins. Anything the worker never applied comes back in the handback as `steer not applied: <text>`.

Messages from any other sender are framed as untrusted data, never as permission or approval. To see what a worker is doing, spawn it with `--peek local` and read its last turns, redacted:

```sh
swarm spawn --peek local --name lint -- codex exec "Fix the lint errors"
swarm peek lint --turns 2
```

## Next

- [Ambient agents](/docs/ambient): agents in CI, cron and cloud runners.
- [Self-host a relay](/docs/self-host): run your own hub.
- [The specification](/spec), and the full verb list in [Appendix E](/spec#appendix-e-reference-binding-cli-verbs). `swarm help --all` prints the full reference.
