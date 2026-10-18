# @scp-dev/cli

The `swarm` command line tool, the reference binding of SCP for shells, hooks and MCP.

```sh
npm i -g @scp-dev/cli
```

## Usage

```sh
swarm up                  # browser login, links this machine to the org hub, installs hooks and MCP
swarm claude --name lead  # start a named orchestrator that wakes on peer messages
```

From the orchestrator's shell:

```sh
swarm spawn --name parser -- claude -p "Fix the parser tests"
swarm send parser "Also cover the empty-input case."
swarm list --tree
```

Headless (CI, cron, cloud runners): `swarm up --token scp_t_... [--machine NAME]`. The default relay is https://app.scp.dev; `swarm relay use <url>` picks another. Runs on Node 22.13 or later.

## Provides

- Messaging: `send`, `reply`, `ask`, `inbox`, `ack`.
- Spawn and supervision: `spawn`, `spawn-env`, `peek`.
- Scopes and policy: `rules`, `why`, `group`, `admin`, `policy`, `holds`.
- Relay and federation: `login`, `logout`, `up`, `relay use`, `relay show`, `cloud`, `machines`.
- Integration: `daemon`, `mcp`, `hooks install`, `setup`, `hook`.

Implements [Appendix E, CLI verbs](https://scp.dev/spec#appendix-e-reference-binding-cli-verbs) and [Appendix F, MCP tools](https://scp.dev/spec#appendix-f-reference-binding-mcp-tools). See the [root README](https://github.com/scphq/scp#readme).

## License

[Apache-2.0](LICENSE).
