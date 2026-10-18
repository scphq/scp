# Getting started

The `swarm` CLI is the reference implementation of SCP. It runs a broker on your machine, mounts an MCP server in your harnesses and installs hooks that deliver messages at turn boundaries.

## Install

```sh
npm i -g @scp-dev/cli
swarm --version
```

The broker starts on demand. A swarm on one machine needs no account; sign in to link machines through your org's hub.

## Sign in

```sh
swarm login
```

`swarm login` opens the relay's device page in your browser and prints a code. Check that the page shows the same code, approve it, and the CLI stores the credential in `~/.config/scp/credentials.json`.

| Where you are | Command |
| --- | --- |
| A desktop with a browser | `swarm login` |
| SSH, a container, no browser | `swarm login --no-browser`, then open the printed URL on any device |
| You already have a token | `swarm login --token <token>` |

`--token` checks the token with the relay before saving it. `--label <name>` names the device credential, and defaults to the short hostname. `swarm logout` removes the stored credential.

Then link this machine's broker to the hub:

```sh
swarm cloud enable
swarm cloud status
```

`swarm up` does all of it in one step: it logs in if needed, links the broker and runs `swarm setup --write`.

## Install the hooks

Each harness needs the MCP server (pull: the model calls `relay_send`, `relay_inbox`, `relay_reply`) and the hooks (push: messages enter the model's context after tools, on prompts and at stops).

```sh
swarm setup            # print the plan for every installed harness
swarm setup --write    # apply it, at user scope
```

Or one harness at a time:

```sh
swarm hooks install --harness claude            # print the hooks and the file they go in
swarm hooks install --harness claude --write    # merge them in, with a backup
swarm mcp install --harness claude              # print the command that mounts the MCP server
```

`hooks install` takes `claude`, `codex`, `opencode`, `agy` or `muse`, and `--scope project|user|local`. Claude Code defaults to `local` (`.claude/settings.local.json`). `swarm setup --undo` removes what setup added. See [Harnesses](/docs/harnesses) for what each integration does.

## A first swarm

From a terminal, spawn a worker in the background:

```sh
swarm spawn --bg --name parser -- claude -p "Fix the parser tests"
```

`spawn` runs the harness with a grant that places the worker under you, with scope `parent`. Without `--name` the worker is `<harness>-<5 random characters>`. From an agent's shell, `spawn` returns at once without `--bg`.

```sh
swarm list --tree                                     # agents nested by parent
swarm send parser "Also cover the empty-input case."  # message the worker
swarm inbox --wait 50                                 # wait for its reply or handback
```

When the worker exits you get a handback: its exit code and final output, so it need not report back itself. `swarm status` shows the fleet in short and `swarm watch` tails it live.

The same works from inside a harness. An orchestrator session runs `swarm spawn` in its shell, and while its workers run, its stop hook waits up to 600 s (`--push-wait`) for their next message or handback and continues the turn with it.

## Steer a worker

Only the parent that spawned a worker can steer it. Your messages to it carry a steer key, and the worker's hooks frame them as a new instruction from the source of its task:

```sh
swarm send parser "Skip the fuzz suite, it is flaky on CI."
```

The message reaches the worker after its next tool call. It applies the message before it finishes, and where it conflicts with an earlier instruction, the newer one wins. Anything the worker never applied comes back in the handback as `steer not applied: <text>`.

Messages from any other sender are framed as untrusted data, never as permission or approval. To see what a worker is doing, spawn it with `--peek local` and read its last turns, redacted:

```sh
swarm spawn --bg --peek local --name lint -- codex exec "Fix the lint errors"
swarm peek lint --turns 2
```

## Next

- [Ambient agents](/docs/ambient): agents in CI, cron and cloud runners.
- [Self-host a relay](/docs/self-host): run your own hub.
- [The specification](/spec), and the full verb list in [Appendix E](/spec#appendix-e-reference-binding-cli-verbs). `swarm help --all` prints the full reference.
