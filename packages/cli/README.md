# @scp-dev/cli

The `swarm` command line tool, the reference binding of SCP for shells, hooks and MCP.

```sh
npm install -g @scp-dev/cli
```

## Usage

```sh
swarm hooks install
swarm spawn --name parser -- claude "Fix the parser tests"
swarm send parser "Also cover the empty-input case."
swarm list --tree
swarm inbox --wait 30
```

This release ships `help` and `version`; the verbs below follow.

## Provides

- Messaging: `send`, `reply`, `ask`, `inbox`, `ack`.
- Spawn and supervision: `spawn`, `spawn-env`, `peek`.
- Scopes and policy: `rules`, `why`, `group`, `admin`, `policy`, `holds`.
- Federation: `cloud`, `machines`, `contacts`.
- Integration: `daemon`, `mcp`, `hooks install`, `setup`.

Implements [Appendix E, CLI verbs](https://scp.dev/spec#appendix-e-reference-binding-cli-verbs) and [Appendix F, MCP tools](https://scp.dev/spec#appendix-f-reference-binding-mcp-tools). See the [root README](https://github.com/scphq/scp#readme).

## License

[Apache-2.0](LICENSE).
