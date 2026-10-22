# Harnesses

Every integration has two parts. The MCP server, mounted under the name `scp`, gives the model pull: `relay_send`, `relay_inbox`, `relay_reply`, `relay_ask` and the other tools of [MCP server](/docs/implementation#mcp-server). The hooks give it push: new messages enter the model's context at turn boundaries, without the model asking. Pull alone is conforming; hooks make delivery native.

```sh
swarm setup --write                          # every installed harness, at user scope
swarm hooks install --harness codex --write  # one harness
swarm mcp install --harness codex            # print the command that mounts the MCP server
```

Every hook runs `swarm hook <harness> [event]` with the harness's JSON payload on stdin and prints only the reply. A hook never fails the harness.

## What each hook point does

| Hook point | Effect |
| --- | --- |
| Session start | Claims the session's endpoint, sets status `working` |
| Prompt submit | Injects new messages with the prompt |
| After tool | Injects new messages after a tool call, records the tool as activity |
| Stop | Names each unanswered request; holds the stop while a `--require-reply` request waits; with running workers, waits for their next message (stop push) |
| Session end | Sets status `done` |

Stop push: while workers you started with `swarm spawn` run, a stop waits up to 600 s for their next message or handback and continues the turn with it. Claude Code and Codex show "waiting for worker messages (swarm)" meanwhile, and a prompt hook that runs ends the wait. A session that a message wakes anyway (one that wakes when idle, below) does not wait: its turn ends and the worker's message wakes it. A worker counts only while it, or the `swarm spawn` that started it, still runs. `--push-wait <s>` changes the wait, `0` turns it off, and `SCP_PUSH_WAIT` lowers it for one session.

## Per harness

| Harness | Hooks | Injection | Stop push | Subagents | Wakes when idle |
| --- | --- | --- | --- | --- | --- |
| Claude Code | Settings hooks | After tools and on prompts | Yes | Yes | Under `swarm claude`, and in background sessions |
| Codex | `hooks.json` | After tools and on prompts | Yes | No | Under `swarm codex`; else queued into the thread once a turn ended |
| Grok | Claude Code's hooks | After tools only | Yes | No | Headless, under `swarm grok` |
| Muse | A plugin | After tools and on prompts | Yes | No | No |
| T3 Code | Its provider's (codex, Claude Code) | As the provider | As the provider | As the provider | Under `swarm t3code` |
| Claude desktop app, Code tab | Claude Code's | As Claude Code | Yes | Yes | Yes, through `claude-inbox` |
| Claude Cowork (local) | A plugin | As Claude Code | Yes | Yes | Yes, through `claude-inbox` |
| Claude desktop app, chat | None (an extension mounts MCP) | No, pull only | No | No | No |
| Codex desktop app | Codex's `hooks.json` | As Codex | Yes | No | Yes, queued into the thread |
| Gemini / Antigravity (agy) | `hooks.json` | Before each model call | No | No | Headless, under `swarm agy` |
| OpenCode | A plugin | Appended to tool output | Emulated | Child sessions as activity | Yes, by the plugin |
| Pi | An extension, no hooks | Each message as it arrives | No | No | Yes, under `swarm pi` |

**Claude Code.** Hooks for SessionStart, UserPromptSubmit, PostToolUse, Stop, SubagentStop and SessionEnd, in `~/.claude/settings.json` from `swarm setup`, or `.claude/settings.local.json` from `swarm hooks install`. Each subagent gets its own child endpoint, `<session handle>-<short type>-<first 4 of its id>` (`gp` for general-purpose, else the type's first word), and receives messages after its tools. Hooks run only on a turn, so an idle session sees new messages at its next prompt. `swarm claude [--name N | --as N] [claude args...]` starts Claude Code with `--dangerously-load-development-channels server:scp`, and `swarm setup` mounts its MCP server with `--channels`, so messages are pushed as channel notifications and wake the idle session. The push goes only to the Claude Code that `swarm claude` started; other sessions keep the hook path. It refuses to start when Claude Code has no `scp` mount with `--channels`. `swarm claude --bg [--name N]` starts a background session (`claude --bg`) instead: its environment comes from Claude Code's daemon, so the launcher hands it an `--mcp-config` whose `scp` server carries the name and the caller's `$SCP_GRANT`. That server replaces your `scp` mount for the session, so `env $(swarm spawn-env --name N) swarm claude --bg --name N` puts the session under you, woken through its inbox (`claude-inbox`). It prints the short id and the address. `swarm claude attach <id|name> [--name N]` opens it, renaming its endpoint first, and `swarm claude --resume <id>` of a live background session attaches to it.

**Codex.** The same events in `~/.codex/hooks.json` from `swarm setup`, or `.codex/hooks.json` from `swarm hooks install`. Codex runs new hooks only after you review them in `/hooks`. `swarm spawn codex exec ...` hands the worker its grant through `-c` overrides; since `codex exec` runs no stop hook, a steer sent after its last step resumes the session (at most twice) before the handback. `swarm codex [--name N] [codex args...]` runs codex app-server with the TUI attached and pushes each message into the session: it starts a turn on an idle thread and steers a running one. `--headless` runs an ambient worker with no TUI that declines approval requests; `--resume <threadId>` reopens a thread.

**Grok.** Runs Claude Code's hooks (install with `--harness claude`), labelled `grok`. It drops prompt-hook context, so messages reach it after tools. `swarm grok [--name N] [grok args...]` runs grok headless and wakes it: see [Headless wake](#headless-wake).

**Muse.** Loads hooks only from plugins. `hooks install --harness muse` writes the plugin; install it with `muse plugins install`, then approve its hooks with `muse plugins approve scp` (`swarm setup --write` runs both). A headless `muse exec`, which is what `swarm spawn -- muse exec ...` runs, has no review prompt and runs no hook Muse holds for review. Muse passes hooks only a fixed set of environment variables, so the hooks find the broker at its default path, not through `SCP_DIR` or `XDG_STATE_HOME`. `swarm muse [--name N] [--approval-mode never] [-- muse serve args...]` runs a headless Muse session that messages wake: it hosts the session through `muse serve`, starts a turn on the idle session or steers a running one with each message, and prints the agent's replies. Muse's TUI cannot attach to that session, and Muse wakes no session from a hook, so an interactive `muse` reads new messages at its next turn.

**T3 Code.** T3 Code drives other harnesses (codex, Claude Code and more) and has no agent loop of its own, so its sessions load the `scp` mount and the hooks `swarm setup --write` installs for codex and Claude Code; T3 Code itself needs no setup, and `swarm setup` only reports it. Those sessions show up as harness `t3code`, and their hooks still answer in the provider's format. `swarm t3code --thread <id> [--name N] [--base-dir DIR]` holds an endpoint for one thread and wakes it: each message goes to the thread as a user message that starts a turn when it is idle or steers the running one, retried every 2 s until T3 Code takes it. It finds the running server under `~/.t3` (or `--base-dir`, `$T3CODE_HOME`, `$SCP_T3_URL`) and gets a token from `t3 auth session issue` unless `$SCP_T3_TOKEN` is set. The thread's own agent still joins through its provider's mount as a separate `t3code` endpoint.

**Claude desktop app.** The Code tab runs Claude Code, so `swarm setup --write` covers it: the `scp` mount in `~/.claude.json` and the hooks in `~/.claude/settings.json`. Its sessions are labelled `claude-desktop` (the app sets `CLAUDE_CODE_ENTRYPOINT=claude-desktop`) and wake like any Claude Code session without channels, through `claude-inbox`. Chat has no hooks and no wake; it mounts the MCP server through a desktop extension. `swarm setup claude-desktop` builds `~/.config/scp/scp.mcpb` (or `--out FILE`) and says how to install it; `--open` opens it in the app. Chat is pull only: the model reads new messages when it calls `relay_inbox`, and its endpoint is labelled `claude-desktop-chat`. The extension runs `swarm` by absolute paths, so rebuild it after moving or upgrading node or `swarm`. Setup never edits `claude_desktop_config.json`.

**Claude Cowork (local).** `swarm setup --cowork` builds the plugin zip in SCP's state directory. Upload it in Claude: Customize, Plugins, Add, Upload plugin. Its sessions are labelled `claude-cowork` and wake through `claude-inbox`. Local sessions only; scheduled tasks do not wake; cloud sessions are unsupported. Plugins sync to your account and into terminal Claude Code, where the plugin stays inert: a connected `scp` server with no tools and hooks that do nothing, since the terminal has its own setup mount. Rebuild the plugin after moving or upgrading node or `swarm`.

**Codex desktop app.** The app runs its own `codex app-server` with the same `~/.codex`, so the `scp` mount in `config.toml` and the hooks in `hooks.json` work after `swarm setup --write`; review the hooks once in the app as in the CLI. Its threads are labelled `codex-desktop` (the app sets `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=Codex Desktop`, and its app-server runs from the app bundle). Messages arrive at turn boundaries. Once a thread ended a turn, a message to it is queued into the thread with `codex queue`, and the app is asked to open it in the background (`open -g codex://threads/wake/<id>`) when it or nobody holds the thread; the app runs it as a follow-up turn, never a steer. `swarm codex --resume` refuses a thread the app holds and suggests `codex fork`.

Desktop apps start the mount and the hooks without your shell's `PATH`, so `swarm setup` writes them by absolute paths: a `swarm` installed as a node script (npm, nvm, fnm, Homebrew) runs as the absolute `node` plus the script's real path, and anything else (a native build, a Volta shim) by its own absolute path. Entries an earlier setup wrote with a bare `swarm` are rewritten in place, each file backed up first; other entries are left as they are. Rerun `swarm setup --write` after moving or upgrading node or `swarm`.

**Gemini / Antigravity (agy).** agy reads nothing back from an after-tool hook, so messages go in before each model call as ephemeral steps. The stop hook continues only when the turn ended without a tool call, and shows directives as a count and a pointer. Shown messages are marked injected, not acknowledged. `swarm agy [--name N] [agy args...]` runs agy headless and wakes it: see [Headless wake](#headless-wake).

**OpenCode.** A plugin appends new messages to tool output; a prompt shows only the unread count. OpenCode has no stop hook: when the session goes idle, the plugin submits a held stop's text as a new prompt. While the session is idle, the plugin keeps one `swarm hook opencode --wake 50` waiting and submits the messages it returns as a new prompt, so a message wakes the session; a message to an OpenCode with no session open yet opens one and runs a turn in it. `SCP_WAKE=0` turns that off. `swarm opencode [--name N] [opencode args...]` starts OpenCode with your own config and arguments, wake on, and refuses to start without the current plugin.

**Pi.** Install pi with `npm i -g @earendil-works/pi-coding-agent`, then run `swarm pi --name N`. It starts pi with the extension that ships inside the CLI: the relay tools, and each new message as a turn that steers a running one or wakes an idle session. `SCP_PI=0` turns the extension off.

A session that a message can wake advertises how: `channels` (`swarm claude`), `claude-inbox` (a Claude Code session without channels, such as `claude --bg`, through its own inbox socket), `codex-app-server` (`swarm codex`), `agy-resume` (`swarm agy`), `grok-resume` (`swarm grok`), `muse-serve` (`swarm muse`), `t3code` (`swarm t3code`), `opencode-plugin` or `pi`. `swarm list` shows it in the `WAKE` column, and `turn` for a session that reads new messages at its next turn.

## Headless workers

| Harness | Spawn |
| --- | --- |
| Muse | `swarm spawn -- muse exec --approval-mode never "<task>"`; spawn adds `--contributor-mode off` unless you pass `on`. `swarm spawn -- swarm muse --approval-mode never` keeps a worker that each message wakes |
| Gemini / Antigravity (agy) | `swarm spawn -- agy -p "<task>"`; needs the `mcp(scp/...)` allow rules `swarm setup` writes |

A `muse exec` worker takes late messages through its stop hook, an agy worker through its stop hook's continue, and an idle interactive session sees them at its next turn. `swarm muse` keeps a Muse worker that each message wakes; `swarm agy` and `swarm grok` wake headless, below.

## Headless wake

agy and grok have no local way to start a turn in an interactive session, so they wake headless: `swarm agy` and `swarm grok` hold the endpoint and run one headless turn per batch of new messages, each resuming the same conversation.

```sh
swarm agy --name docs -- -p "read the open issues"   # this prompt is the first turn
swarm grok --name review                             # waits; the first message starts the session
```

- A prompt flag in your arguments (`-p`) is the first turn, run with your arguments as given. Without one the launcher prints `waiting for messages`, and the first message opens the conversation.
- Each new message becomes a turn: your arguments without the prompt, plus `--conversation <id> -p <message>` for agy or `--resume <id> -p <message>` for grok. Messages that arrive during a turn wait for the next one and go in together.
- grok's session id is yours (`-s`, `-r`) or a new one the first turn passes as `-s`. agy cannot be given an id for a new conversation, so its `scp` hooks report the one it opened: `swarm agy` refuses to start without them (`swarm setup --write` installs them) and stops if a turn ends without the report.
- Each message is delivered once. The launcher's channel confirms it, so agy's hook does not show it again before a model call, and a message the hook already showed never reaches the channel. A failed turn ends the launcher with its exit code; its messages stay unread in `relay_inbox`.
- Interactive flags are refused (agy `-i`, `-c`, `--input-format`, `--remote-control`; grok `-c`, `--fork-session`). Run plain `agy` or `grok` for an interactive session: it reads new messages through its hooks, not woken.
- grok gets `--allow` rules for the relay messaging tools unless you pass your own permission flags. A headless agy needs the `mcp(scp/...)` allow rules `swarm setup` writes; `swarm agy` warns without them.
- `$SCP_AGY_BIN` and `$SCP_GROK_BIN` pick the binaries.

Every launcher (`swarm claude`, including `--bg`, `swarm codex`, `muse`, `pi`, `opencode`, `agy`, `grok` and `t3code`) run from an agent's shell links the session it starts under that agent by itself: it mints the grant `swarm spawn-env --name N` would, with the agent's own authority. `swarm claude --bg` then prints `under me/<agent>` after the address. A grant minted for the session in `$SCP_GRANT` is used as is (an agent's own spent grant is replaced), `--root` starts the session as a root, a resumed session keeps its place, and from a plain terminal nothing changes. If the grant cannot be minted, the session still starts, unlinked, with a one-line warning.

## Any other harness

A harness joins if it can run a shell command or mount an MCP server. Each hook it exposes adds a delivery point: an after-tool hook gives injection after tools, a prompt hook injection on prompts, and a stop hook that can continue with text gives required replies, steering and stop push. The capability classes are in [section 8.9](/spec#8-9-harness-capability-classes), and the exact events and output shapes per harness in [harness bindings](/docs/implementation#harness-bindings).
