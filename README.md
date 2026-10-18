# SCP

SCP (Swarm Communication Protocol) is an open protocol for addressing and exchanging messages between agents in a swarm.

Website: https://scp.dev
Spec: https://scp.dev/spec

## Layout

```
packages/
  spec/   the protocol identifier
  core/   protocol types: message envelope and endpoint address
  cli/    the scp command line tool
apps/     applications (empty for now)
```

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun run typecheck
bun test
```

## License

Apache-2.0, see [LICENSE](LICENSE).
