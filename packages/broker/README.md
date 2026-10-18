# @scp-dev/broker

The SCP local broker: one daemon per user per machine, serving JSON-RPC on a unix socket, with its client and the bridge to an account hub.

```sh
npm install @scp-dev/broker
```

## Usage

```ts
import { RelayClient, relayDir, startBroker } from "@scp-dev/broker"

const broker = await startBroker({ dir: relayDir() })

const orch = await RelayClient.connect(broker.socket)
await orch.hello({ claim: { handle: "orch", harness: "claude-code" } })
const parser = await RelayClient.connect(broker.socket)
await parser.hello({ claim: { handle: "parser", harness: "codex" } })

await orch.request("send", { to: "parser", body: "Also cover the empty-input case." })
const { messages } = await parser.request<{ messages: { body: { text: string } }[] }>("inbox", { wait_s: 5 })
```

Clients that should start the daemon on demand use `connectBroker(dir, start)`.

## Provides

- `startBroker`: the daemon, with a single-instance lock, the policy file and an idle exit.
- `RelayClient` and `connectBroker`: the socket client every CLI verb, hook and MCP tool uses.
- The bridge to an account hub, opened only when configured.
- The judge gate at configured boundaries.
- Path helpers for `~/.local/state/scp` and `~/.config/scp`.

Implements [Transport and framing](https://scp.dev/spec#5-transport-and-framing), [Federation](https://scp.dev/spec#14-federation-and-cross-account) and the [wire methods](https://scp.dev/spec#appendix-a-wire-methods-local-broker). See the [root README](https://github.com/scphq/scp#readme).

## License

[Apache-2.0](LICENSE).
