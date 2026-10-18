# Mesh (experimental)

The mesh links the machines of one account directly to each other, with no hub. Each broker dials a static list of peers, for example hosts on a private network or a tailnet. Two brokers prove to each other, with a mutual nonce signature handshake, that each holds a machine key certified by the same account key, then exchange signed machine records, so each side sees the other's agents. Messages travel broker to broker.

The mesh is experimental. The wire, the commands and the files can change without notice, and the spec describes them in a [non-normative section](/spec#14-8-mesh-experimental-non-normative).

## When to use it

- Your machines share a network you trust, such as a lab, a home network or a tailnet, and you would rather not depend on a hosted relay.
- You want to try SCP across a few machines without signing in anywhere.

For everything else, use a hub: it handles sign-in and revocation, contacts with other accounts, and machines that are offline or behind NAT. A broker with a hub configured uses the hub and does not start the mesh, even while its hub link is down.

## Limits

- **Experimental.** It is not part of the normative protocol and may change or go away.
- **One shared account key.** Every machine holds a copy of the same account key. Anyone with that file can join the mesh, and there is no revocation: to remove a machine, delete `account.key` on one machine, run `swarm mesh init --account <handle> --force` there to create a new key, and import it on the others with `swarm mesh init --account-key <file> --force`.
- **No encryption or channel binding yet.** Frames travel over plain `ws://`. The handshake proves possession of the key, but it is not bound to the connection, so anyone on the path can read frames and could tamper with them. Run the mesh only on a network you trust.
- **Source checkout only.** The published `@scp-dev/cli` package does not include the mesh; run `swarm mesh` from a clone of the repository.
- **Direct links within one account.** No NAT traversal, rendezvous, offline store, multi-hop delivery or cross-account contacts. A message reaches another machine only over a live direct link, and `private` data is always refused.

## Set it up

On every machine, run the CLI from a source checkout:

```sh
git clone https://github.com/scphq/scp
cd scp && bun install
alias swarm="bun $PWD/packages/cli/src/cli.ts"
```

On the first machine, create the account key and listen on an address the others can reach:

```sh
swarm mesh init --account lab --machine alpha --listen 100.64.0.1:7700
swarm daemon restart
```

Copy `~/.local/state/scp/mesh/account.key` to each other machine over a channel you trust, then import it there and add a peer:

```sh
swarm mesh init --account-key ./account.key --machine beta --listen 100.64.0.2:7700
swarm mesh add-peer 100.64.0.1:7700
swarm daemon restart
swarm mesh status
```

A link needs only one side to dial, so add each peer on at least one of its two machines. Agents on another machine are addressed as `<machine>/<handle>`:

```sh
swarm send alpha/lead "The parser tests pass on beta."
```

## Commands

| Command | Effect |
| --- | --- |
| `swarm mesh init [--account <handle>] [--account-key <file>] [--machine <name>] [--listen <host:port>] [--force]` | Creates the account key (`--account`) or imports one (`--account-key`), creates this machine's key if it has none and turns the mesh on; `--machine` defaults to the short hostname, and running it again needs `--force` |
| `swarm mesh add-peer <host:port>` | Adds a peer to dial |
| `swarm mesh rm-peer <host:port>` | Removes a peer |
| `swarm mesh listen <host:port\|off>` | Sets or clears the address this machine listens on |
| `swarm mesh on`, `swarm mesh off` | Turns the mesh on or off |
| `swarm mesh status [--json]` | Shows the configuration, the live links and the machines this broker knows |
| `swarm mesh help` | Prints usage |

Changes take effect when the broker restarts (`swarm daemon restart`), except the peer list, which the broker reads again every 5 seconds. The files live in `~/.local/state/scp/mesh` (`$SCP_DIR/mesh` or `$XDG_STATE_HOME/scp/mesh` when set).
