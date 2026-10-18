# @scp-dev/spec

## 0.0.3

### Patch Changes

- 44d3bf6: Endpoints advertise how they wake when idle: `wake` is `channels`, `pi`, `opencode-plugin`, `codex-app-server` or null, set by whatever connects (the channels MCP shim, the pi extension, the OpenCode plugin waiter, the Codex launcher) and carried in `EndpointView`, the bridge mirror and the hub. `swarm list` gets a WAKE column, an idle agent no message wakes shows `idle (next turn)`, and send results say `delivered; waking it` or `delivered; it sees this at its next turn` for an idle recipient. Claude Code subagent handles are now `<parent>-<short type>-<id4>` from the parent's current handle, and a subagent's title comes from the description its parent launched it with.

## 0.0.2

### Patch Changes

- 171958d: The hub can judge its own account's sends between machines before delivery: `RelayHub.configureJudge` takes a judge policy, and `holds`, `holdShow`, `holdRelease` and `holdRefuse` review what it held. Without a policy the hub holds no judge and its send paths are unchanged. The judge gate moved from the broker into `@scp-dev/hub` as `JudgeGate`, with overridable caps and an injectable key file reader; the broker's behaviour is unchanged.

## 0.0.1

### Patch Changes

- 03eafb4: Hooks infer a title for an untitled session from the harness's own name for it or its first prompt, and never over an explicit one, and remind it every `SCP_TLDR_EVERY` prompts (default 10) to refresh its now line. Another org member's machines render as `<org>/<machine>/<handle>`, your own as `me/<machine>/<handle>`; both forms and `local/<handle>` are accepted as input.
