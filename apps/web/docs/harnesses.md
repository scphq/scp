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

| Harness | Hooks | Injection | Stop push | Subagents |
| --- | --- | --- | --- | --- |
| Claude Code | Settings hooks | After tools and on prompts | Yes | Yes |
| Codex | `hooks.json` | After tools and on prompts | Yes | No |
| Grok | Claude Code's hooks | After tools only | Yes | No |
| Muse | A plugin | After tools and on prompts | Yes | No |
| Gemini / Antigravity (agy) | `hooks.json` | Before each model call | No | No |
| OpenCode | A plugin | Appended to tool output | Emulated | Child sessions as activity |

**Claude Code.** Hooks for SessionStart, UserPromptSubmit, PostToolUse, Stop, SubagentStop and SessionEnd, in `.claude/settings.local.json` by default. Each subagent gets its own child endpoint, `<session>-<type>-<id>`, and receives messages after its tools. Hooks run only on a turn, so an idle session sees new messages at its next prompt. `swarm claude [--name N] [claude args...]` starts Claude Code with `--dangerously-load-development-channels server:scp`, and `swarm setup` mounts its MCP server with `--channels`, so messages are pushed as channel notifications and wake the idle session. The push goes only to the Claude Code that `swarm claude` started; other sessions keep the hook path.

**Codex.** The same events in `.codex/hooks.json`. Codex runs new hooks only after you review them in `/hooks`. `swarm spawn codex exec ...` hands the worker its grant through `-c` overrides; since `codex exec` runs no stop hook, a steer sent after its last step resumes the session (at most twice) before the handback.

**Grok.** Runs Claude Code's hooks (install with `--harness claude`), labelled `grok`. It drops prompt-hook context, so messages reach it after tools.

**Muse.** Loads hooks only from plugins. `hooks install --harness muse` writes the plugin; install it with `muse plugins install`.

**Gemini / Antigravity (agy).** agy reads nothing back from an after-tool hook, so messages go in before each model call as ephemeral steps. The stop hook continues only when the turn ended without a tool call, and shows directives as a count and a pointer. Shown messages are marked injected, not acknowledged.

**OpenCode.** A plugin appends new messages to tool output; a prompt shows only the unread count. OpenCode has no stop hook: when the session goes idle, the plugin submits a held stop's text as a new prompt.

## Any other harness

A harness joins if it can run a shell command or mount an MCP server. Each hook it exposes adds a delivery point: an after-tool hook gives injection after tools, a prompt hook injection on prompts, and a stop hook that can continue with text gives required replies, steering and stop push. The capability classes are in [section 8.9](/spec#8-9-harness-capability-classes), and the exact events and output shapes per harness in [Appendix G](/spec#appendix-g-harness-hook-bindings).
