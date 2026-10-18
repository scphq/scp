# Harnesses

Every integration has two parts. The MCP server, mounted under the name `scp`, gives the model pull: `relay_send`, `relay_inbox`, `relay_reply`, `relay_ask` and the other tools of [Appendix F](/spec#appendix-f-reference-binding-mcp-tools). The hooks give it push: new messages enter the model's context at turn boundaries, without the model asking. Pull alone is conforming; hooks make delivery native.

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

Stop push: while workers you started with `swarm spawn` run, a stop waits up to 600 s for their next message or handback and continues the turn with it. `--push-wait <s>` changes the wait, `0` turns it off, and `SCP_PUSH_WAIT` lowers it for one session.

## Per harness

| Harness | Hooks | Injection | Stop push | Subagents | Wakes when idle |
| --- | --- | --- | --- | --- | --- |
| Claude Code | Settings hooks | After tools and on prompts | Yes | Yes | Under `swarm claude` |
| Codex | `hooks.json` | After tools and on prompts | Yes | No | Under `swarm codex` |
| Grok | Claude Code's hooks | After tools only | Yes | No | No |
| Muse | A plugin | After tools and on prompts | Yes | No | No |
| Gemini / Antigravity (agy) | `hooks.json` | Before each model call | No | No | No |
| OpenCode | A plugin | Appended to tool output | Emulated | Child sessions as activity | Yes, by the plugin |
| Pi | An extension, no hooks | Each message as it arrives | No | No | Yes, under `swarm pi` |

**Claude Code.** Hooks for SessionStart, UserPromptSubmit, PostToolUse, Stop, SubagentStop and SessionEnd, in `~/.claude/settings.json` from `swarm setup`, or `.claude/settings.local.json` from `swarm hooks install`. Each subagent gets its own child endpoint, `<session handle>-<short type>-<first 4 of its id>` (`gp` for general-purpose, else the type's first word), and receives messages after its tools. Hooks run only on a turn, so an idle session sees new messages at its next prompt. `swarm claude [--name N | --as N] [claude args...]` starts Claude Code with `--dangerously-load-development-channels server:scp`, and `swarm setup` mounts its MCP server with `--channels`, so messages are pushed as channel notifications and wake the idle session. The push goes only to the Claude Code that `swarm claude` started; other sessions keep the hook path. It refuses to start when Claude Code has no `scp` mount with `--channels`.

**Codex.** The same events in `~/.codex/hooks.json` from `swarm setup`, or `.codex/hooks.json` from `swarm hooks install`. Codex runs new hooks only after you review them in `/hooks`. `swarm spawn codex exec ...` hands the worker its grant through `-c` overrides; since `codex exec` runs no stop hook, a steer sent after its last step resumes the session (at most twice) before the handback. `swarm codex [--name N] [codex args...]` runs codex app-server with the TUI attached and pushes each message into the session: it starts a turn on an idle thread and steers a running one. `--headless` runs an ambient worker with no TUI that declines approval requests; `--resume <threadId>` reopens a thread.

**Grok.** Runs Claude Code's hooks (install with `--harness claude`), labelled `grok`. It drops prompt-hook context, so messages reach it after tools.

**Muse.** Loads hooks only from plugins. `hooks install --harness muse` writes the plugin; install it with `muse plugins install`, then approve its hooks with `muse plugins approve scp` (`swarm setup --write` runs both). A headless `muse exec`, which is what `swarm spawn -- muse exec ...` runs, has no review prompt and runs no hook Muse holds for review. Muse passes hooks only a fixed set of environment variables, so the hooks find the broker at its default path, not through `SCP_DIR` or `XDG_STATE_HOME`.

**Gemini / Antigravity (agy).** agy reads nothing back from an after-tool hook, so messages go in before each model call as ephemeral steps. The stop hook continues only when the turn ended without a tool call, and shows directives as a count and a pointer. Shown messages are marked injected, not acknowledged.

**OpenCode.** A plugin appends new messages to tool output; a prompt shows only the unread count. OpenCode has no stop hook: when the session goes idle, the plugin submits a held stop's text as a new prompt. While the session is idle, the plugin keeps one `swarm hook opencode --wake 50` waiting and submits the messages it returns as a new prompt, so a message wakes the session; a message to an OpenCode with no session open yet opens one and runs a turn in it. `SCP_WAKE=0` turns that off. `swarm opencode [--name N] [opencode args...]` starts OpenCode with your own config and arguments, wake on, and refuses to start without the current plugin.

**Pi.** Install pi with `npm i -g @earendil-works/pi-coding-agent`, then run `swarm pi --name N`. It starts pi with the extension that ships inside the CLI: the relay tools, and each new message as a turn that steers a running one or wakes an idle session. `SCP_PI=0` turns the extension off.

A session that a message can wake advertises how: `channels` (`swarm claude`), `codex-app-server` (`swarm codex`), `opencode-plugin` or `pi`. `swarm list` shows it in the `WAKE` column, and `turn` for a session that reads new messages at its next turn.

## Headless workers

| Harness | Spawn |
| --- | --- |
| Muse | `swarm spawn -- muse exec --approval-mode never "<task>"`; spawn adds `--contributor-mode off` unless you pass `on` |
| Gemini / Antigravity (agy) | `swarm spawn -- agy -p "<task>"`; needs the `mcp(scp/...)` allow rules `swarm setup` writes |

Neither has a wake binding yet: a Muse worker takes late messages through its stop hook, an agy worker through its stop hook's continue, and an idle interactive session sees them at its next turn.

## Any other harness

A harness joins if it can run a shell command or mount an MCP server. Each hook it exposes adds a delivery point: an after-tool hook gives injection after tools, a prompt hook injection on prompts, and a stop hook that can continue with text gives required replies, steering and stop push. The capability classes are in [section 8.9](/spec#8-9-harness-capability-classes), and the exact events and output shapes per harness in [Appendix G](/spec#appendix-g-harness-hook-bindings).
