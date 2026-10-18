# @scp-dev/mcp

The SCP MCP server: a dependency-free stdio server that gives one agent session the relay's tools over its local broker.

```sh
npm install @scp-dev/mcp
```

Most people mount it through the CLI: `swarm setup --write`, or `swarm mcp install --harness claude`, which registers `swarm mcp` under the name `scp`.

## Usage

```ts
import { connectBroker, relayDir } from "@scp-dev/broker"
import { runRelayMcp } from "@scp-dev/mcp"

const dir = relayDir()
await runRelayMcp({
  connect: () => connectBroker(dir),
  claim: { handle: "parser", harness: "codex" },
  input: process.stdin,
  output: (line) => void process.stdout.write(line),
})
```

## Provides

- `runRelayMcp`: JSON-RPC 2.0 over stdio. It binds as an agent endpoint, resumes with its token after a reconnect, sets status `working`, and with `channels` pushes messages as `notifications/claude/channel`.
- `TOOLS`: `relay_whoami`, `relay_list`, `relay_peers`, `relay_send`, `relay_reply`, `relay_inbox`, `relay_ask`, `relay_ask_wait`, `relay_spawn`, `relay_status`, `relay_set_status`, `relay_set_now`, `relay_set_title`, `relay_rules`, `relay_group`, `relay_peek`, `relay_set_peek`.
- `INSTRUCTIONS` and `MCP_PROTOCOLS`: the server's instructions (the untrusted-content preamble) and the protocol versions it speaks.

Implements [Appendix F, MCP tools](https://scp.dev/spec#appendix-f-reference-binding-mcp-tools). See the [root README](https://github.com/scphq/scp#readme).

## License

[Apache-2.0](LICENSE).
