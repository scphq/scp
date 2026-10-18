# Five-minute demo

An orchestrator in Claude Code spawns a Codex worker, steers it and gets its result back, then a teammate's agent on another machine in the same org answers it. Everything runs on the hosted relay at https://app.scp.dev.

You need two machines (yours and a teammate's), Node 22.13 or later, and Claude Code and Codex signed in on yours.

## Before the demo (10 minutes, once)

### 1. Install the CLI, on both machines

```sh
npm i -g @scp-dev/cli
swarm --version
```

From source instead (Bun 1.4 or later), with a `swarm` on your `PATH`, since the hooks call `swarm`:

```sh
git clone https://github.com/scphq/scp && cd scp && bun install
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec bun "%s/packages/cli/src/cli.ts" "$@"\n' "$PWD" > ~/.local/bin/swarm && chmod +x ~/.local/bin/swarm
```

### 2. Sign in, create the org, invite the teammate

1. Open https://app.scp.dev, enter your email, and type the code from the sign-in mail.
2. Create an organization: a handle such as `demo` and a name.
3. On the org page, invite your teammate by email as `member`. They sign in at app.scp.dev with that address and accept the invite.

### 3. Mint an API token for an ambient agent (optional)

An unattended agent (a server, CI, a VM) signs in with an org API token rather than a browser login. On the org page, open **Tokens and devices** and create a token named, say, `runner`. The page shows it once. On that machine:

```sh
swarm up --token scp_t_... --machine runner   # from the page; saves the token, links the broker to the hub, installs hooks and MCP
```

Agents on a token-linked machine carry the label `token=runner`.

### 4. Link each machine and install the hooks

On your machine and on your teammate's:

```sh
swarm up
```

`swarm up` logs in through the browser (check that the device page shows the same code and approve it), links the local broker to the org hub (as the short hostname, or as `--machine NAME`) and installs the MCP server and the hooks in every installed harness, at user scope.

Run it before you start any agent session. A broker that was already running stays local-only until it exits. Check the link:

```sh
swarm cloud status     # broker: connected to https://app.scp.dev as <machine>
```

Codex runs new hooks only after you review them: start `codex` once, open `/hooks` and approve them. Without that, a Codex worker still runs and hands back, but a steer sent mid-run comes back as `steer not applied`.

### 5. Rehearse, and preflight on the day

Run the end-to-end check with two tokens of the org (mint `e2e-a` and `e2e-b` in step 3):

```sh
E2E_TOKEN_A=scp_t_... E2E_TOKEN_B=scp_t_... scripts/e2e-hosted.sh
```

It runs two isolated users with their own brokers, then logs in, links, spawns, sends, reads the inbox, replies and waits for the handback, and prints a pass/fail table. It prints no tokens. `SCP_RELAY=http://127.0.0.1:8787 scripts/e2e-hosted.sh` runs the same flow against a local relay that it starts and seeds itself.

## The demo (5 minutes)

### 0:00 The orchestrator

In a project directory on your machine:

```sh
swarm claude --name lead
```

That is the full interactive Claude Code, started with the scp channel loaded so peer messages wake it even while it is idle. Its hooks join it to the relay as `me/lead`. Without `--name`, the session joins as `me/claude-<directory>`. Show it in a second terminal:

```sh
swarm list
```

### 0:45 Spawn a Codex worker

Prompt the orchestrator:

> Spawn a Codex worker with `swarm spawn --name docs -- codex exec "Read README.md and list three things a new user would trip over."`. Right after it starts, steer it with `swarm send docs "Also suggest a one-line fix for each."`. Then end your turn and report its result when it arrives.

What the audience sees:

- `swarm spawn` returns at once with `docs started (pid ...) and runs in the background`.
- `swarm send docs ...` prints `me/docs: delivered; it sees this at its next tool call or when its turn ends`.
- The orchestrator ends its turn and its stop hook waits for the worker. When Codex exits, the handback lands in the orchestrator's context as a `<relay-message from="me/docs" relation="child" ...>` block, starting with `worker me/docs finished (exit 0)` and followed by the worker's whole reply. The orchestrator then summarises it.

A Claude worker works the same way: `swarm spawn --name rev -- claude -p "..."`. Its handback ends with `your steer <id> was read at <time>`.

### 2:30 A teammate across machines

On the teammate's machine, after `swarm up`:

```sh
swarm claude --name bob
```

Back in your orchestrator:

> Run `swarm list`, find bob on the other machine and ask him with `swarm send me/<their machine>/bob "Can you review the docs findings?"`.

Agents on another member's machines show up as `<org>/<machine>/<handle>`, and those on your own other devices as `me/<machine>/<handle>`. Bob's session gets the message after its next tool call, or with the teammate's next prompt. The teammate tells it to answer, for example "reply that you'll take the first two". It runs `swarm reply <id> "..."`, and the reply arrives in the orchestrator's context as a `<relay-message from="<org>/<their machine>/bob" ...>` block.

### 4:00 Wrap

Show the org page on app.scp.dev. It lists the machines and agents live, with recent activity. `swarm status` gives the same view in short from a terminal.

## If something goes wrong

| Symptom | Fix |
| --- | --- |
| `swarm cloud status` says local-only | The broker started before `swarm up` (any earlier `swarm` command starts one, and it stays up until 30 minutes idle). Close the agent sessions, `kill` the pid that `swarm status` prints, then run `swarm cloud status` again: the next broker links |
| The other machine's agent is missing from `swarm list` | Check `swarm cloud status` on both machines, and that both are in the same org (`swarm login --json` shows `org`) |
| `the human names the endpoint to grant under` | `swarm spawn` from a plain terminal needs a parent: run it from inside the orchestrator, or pass `--as <agent>` or `--under <agent>` |
| A session joins as `lead-2` | A `lead` from an earlier run is still known in another tree. Use a new name, or rehearse with a fresh `SCP_DIR` |
| The Codex steer comes back as `steer not applied` | Review the Codex hooks once in `codex` under `/hooks` |
