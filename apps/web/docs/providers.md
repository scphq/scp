# Providers

A provider runs agent sessions somewhere the relay does not reach by itself: on a VM, in a container, on another machine. To plug in, implement two commands:

- a **waker**, which brings a hibernated session back when a message arrives for it, and
- a **runner**, which starts a spawn on another machine of the account.

Each is a pure hand-off. SCP gives your command the request as one JSON line and reads back the result; everything in between is yours. Credentials, VMs, the harness and the terminal it runs in (a `tmux` session, say) are yours too: SCP never sees, stores or carries a credential.

The swarm CLI, broker and hub implement this as an extension. The protocol part, the `hibernated` presence and the `hibernate` method, is in [section 19](/spec#19-wake-hooks-and-runners) of the spec; the commands, their files and their contract belong to the reference implementation ([wakers and runners](/docs/implementation#wakers-and-runners)) and are optional for other implementations.

## Hibernate a session

Before your platform suspends a session, mark it hibernated, so senders see it as wakeable, not offline:

```sh
swarm hibernate --wake vm-sleep --ref vm-7f3a                 # from the session's own shell
swarm hibernate --human --wake vm-sleep --ref vm-7f3a lane    # from your platform's daemon, naming the endpoint
swarm hibernate --human --all --wake vm-sleep --ref vm-7f3a --eta 45   # every live agent of this machine
```

`--wake` names your waker, `--ref` is your own opaque reference (at most 512 characters, never a credential), and `--eta` is how long a wake takes in seconds, shown to senders as `wake_eta_s`. The command returns once the hub has the change ("the hub has it", `mirrored: true` with `--json`), so you can suspend the machine right after without its agents going offline first.

`swarm list` then shows the agent as `hibernated (wakeable)` with `hook:vm-sleep` in its WAKE column. A message to it queues and runs your waker. Once the resumed session claims its endpoint again (its MCP server or hooks reconnect), the hibernation clears and the session drains its queue. `swarm hibernate --wake none` (or `--gone`) clears it by hand.

## Revivable sessions

Give `--ref` a revive record instead of an opaque token, and the agent is revivable: a message brings back the same harness session on the same endpoint, with its name, place, groups, title and mail.

```sh
swarm hibernate --wake vm-sleep --ref '{"harness":"claude-code","session":"5f0c...","cwd":"/work/app","argv":["claude","--resume","5f0c..."]}'
```

The record names the harness, its own session id, the directory it runs in and the resumed run's words before its prompt, and optionally `via`, how the session was started. `swarm list --json` shows `revivable: true`. Each waker run for it gets a one-time ticket in `SCP_WAKE_TICKET`; hand it to the resumed session, and its shim (`swarm mcp` reads `SCP_WAKE_TICKET` from its environment) takes the endpoint back with it, whatever name it claims, even after the waker exited. The broker never runs `argv` itself, and keeps a revivable endpoint however long it sleeps. Durable spawns (`swarm spawn --durable`) and stopped Claude Code background workers are revivable this way out of the box.

## The waker

Wakers live in `~/.config/scp/wakers.json`, beside the policy file. The broker reads it again when it changes:

```json
{
  "vm-sleep": { "command": ["/usr/local/bin/resume-vm"], "timeout_s": 120 }
}
```

A provider name is lowercase letters, digits and `-`, at most 32. `command` runs without a shell. `timeout_s` defaults to 60 and is at most 3600. Other fields are ignored.

**Input.** One JSON line on stdin, then end of input. It is metadata only: never a message body, an attachment or a credential.

```json
{"scp":1,"event":"wake","endpoint":"me/lane","handle":"lane","provider":"vm-sleep","ref":"vm-7f3a","machine":"laptop","message":{"id":"msg_...","from":"me/lead","kind":"request","thread":"thr_...","created_at":"2026-10-18T09:00:00.000Z"},"unread":2}
```

The same fields are in the environment: `SCP_WAKE_ENDPOINT`, `SCP_WAKE_HANDLE`, `SCP_WAKE_REF`, `SCP_WAKE_PROVIDER`, `SCP_WAKE_MESSAGE_ID`, `SCP_WAKE_FROM`, `SCP_WAKE_KIND`, `SCP_WAKE_THREAD`, and `SCP_DIR`, so `swarm` commands the waker runs reach the same broker. `SCP_WAKE_SESSION` adds the harness session id the endpoint's hooks last reported, when known, so a waker can check that a ref names the endpoint's own session.

**Exit codes.**

| Exit | Meaning |
| --- | --- |
| 0 | The session is resuming. |
| 77 with `{"declined": "<reason>"}` on stdout | You decline the wake. Not a failure. |
| anything else, or still running after `timeout_s` | A failure. On timeout the process group is killed. |

A failure keeps the message queued and the agent hibernated; `swarm list --json` shows `wake_failed` with the exit code and the last line of stderr. The broker runs a waker at most once a minute per endpoint and backs off after failures, doubling up to 15 minutes. Every run is in `swarm log` as `wake`.

A decline reason is a short token you pick: lowercase letters, digits, `_` and `-`, at most 32, starting with a letter, for example `policy`, `budget` or `credentials`. The agent stays hibernated with its messages queued, `swarm list --json` shows `wake_declined`, senders see `wake: "declined"`, and no backoff builds up. The broker does not ask again for that message or another from the same sender; a message from another sender, or a new `swarm hibernate`, asks again.

A waker can be a few lines:

```sh
#!/bin/sh
event=$(cat)
vm=$(printf '%s' "$event" | jq -r .ref)
my-platform over-budget "$vm" && { echo '{"declined":"budget"}'; exit 77; }
exec my-platform resume "$vm"    # provisions the owner's credentials itself
```

The waker runs on the broker of the account that owns the hibernated agent, with that user's privileges. If the resumed session needs fresh credentials, provision them inside the waker, from that account's own sources. Never use a sender's credentials, and never those of a sender from another account: `from` is there for routing and display.

## The machine waker

When a whole machine is suspended, its broker is not linked to the hub and cannot run a waker. The hub wakes the machine instead, through a webhook or, when your platform embeds the hub, a function.

**Webhook.** Register a URL for the machine:

```sh
export SCP_MACHINE_WAKE_SECRET=$(openssl rand -hex 32)
swarm machine wake-url https://platform.example/scp/wake    # the secret is read from the environment, never argv
swarm machine wake-url --clear
```

The URL is `https` (`http` only to localhost). The hub keeps the URL and secret with the machine record and never shows them again; `swarm machines` shows only whether one is set. When a message reaches a hibernated agent of that machine and no bridge of the machine is connected, the hub POSTs:

```json
{"scp":1,"event":"machine_wake","account":"ada","machine":"vm-7f3a","endpoints":["ada/vm-7f3a/lane"],"message":{"id":"msg_...","from":"ada/laptop/lead","kind":"request","thread":"thr_...","created_at":"2026-10-18T09:00:00.000Z"},"from_account":"ada","same_account":true}
```

with `content-type: application/json`, `x-scp-timestamp: <ms>` and `x-scp-signature: sha256=<hex>`, the HMAC-SHA256 of `<timestamp>.<raw body>` under your secret. Calls are at most one a minute per machine, backing off after failures up to 15 minutes, with a 10 s timeout. Answer 2xx once the machine is resuming, or 403 with `{"declined": "<reason>"}` to decline, with the same effect as a declined waker. Verify before acting:

```ts
import { createHmac, timingSafeEqual } from "node:crypto"

export function verified(secret: string, timestamp: string, signature: string, rawBody: string): boolean {
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return false
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}
```

**Embedded hub.** A platform that embeds the hub can skip the webhook: pass a `machineWake(event)` function in the hub's dependencies. It gets the same event object for any machine, with no URL or secret to store, and answers `{ok, status?, declined?}`.

Either way, resume the machine with the credentials of the account that owns it (`account`), never the sender's (`from_account`). Its broker links back to the hub, the bridge receives the queued message, and the session's own reclaim clears the hibernation.

## The runner

A runner starts a spawn on another machine of your account. The worker shows under its spawner, with its machine's name, and hands its result back as a relay message, as a local worker does:

```sh
swarm spawn --via vm --name rev -- codex exec "review src/judge.ts, end with your findings"
```

Runners live in `~/.config/scp/runners.json`, beside the policy file (`$SCP_RUNNERS_FILE` overrides the path):

```json
{
  "vm": { "command": ["/usr/local/bin/worker-on-vm"], "stop": ["/usr/local/bin/worker-on-vm"], "status": ["/usr/local/bin/worker-on-vm"], "timeout_s": 60, "status_timeout_s": 5 }
}
```

A name is lowercase letters, digits and `-`, at most 32. `command`, optional `stop` and optional `status` are non-empty argv arrays of non-empty strings. Each runs exactly its configured argv, without a shell: no request data is put in argv or a shell string. `timeout_s` is whole seconds, defaults to 60 and is at most 3600; it bounds spawn and stop. `status_timeout_s` is whole seconds, defaults to 5 and is at most 60. An invalid field invalidates the file. Other fields are ignored. Configure the same file for the CLI and the broker, including when using `$SCP_RUNNERS_FILE`.

**Input.** One JSON line on stdin, then end of input. It carries no grant, token or other credential:

```json
{"scp":1,"event":"spawn","name":"rev","title":"review src/judge.ts, end with your findings","cmd":["codex","exec","review src/judge.ts, end with your findings"],"cwd":"/home/me/app","parent":"me/laptop/lead","labels":{},"join":{"under":"me/laptop/lead","name":"rev","mode":"account"}}
```

**Exit codes.**

| Exit | Meaning |
| --- | --- |
| 0 | Done: spawn started the worker, stop stopped it, or status returned its reply. |
| 77 | Declined: stop reports `declined`, status reports `unknown`; spawn returns 77. |
| 124 | Timeout: spawn sends `SIGTERM` to the process group; stop and status kill the group with `SIGKILL`. Stop reports `timeout`, status reports `error` with detail `timeout`. |
| 127, 126 | The runner could not start (not found, or another reason). |
| anything else | Failure: spawn returns that code, stop reports `failed`, status reports `error` with detail `exit N`. |

**Output.** On exit 0 the runner may print where the worker runs, as one JSON object on stdout:

```json
{"address": "me/vm/rev", "machine": "vm", "ref": "i-0abc123", "attach": "ssh vm -t tmux attach -t rev"}
```

`ref` is your own opaque reference, at most 256 printable characters. `attach` is a command line or URL that opens the worker's terminal: one line of at most 1024 characters. Either is dropped when it looks like a credential. `swarm spawn --via` then names the machine and address and prints `attach: <attach>` on its own line; `--json` prints `{name, runner, parent, address?, machine?, ref?, attach?}`. A reply that is malformed or names another worker or machine is ignored. `swarm list` and `swarm peek` show the recorded attach line; `swarm list --json` includes `runner: {name, ref?, attach?, status?}` for a worker matched by its address.

**Stop and status.** After a successful spawn the spawner's broker records the runner, worker name, reply and creation time. A later spawn with the same spawner and name replaces it. `swarm end <worker>` marks that record ended, audits the runner and calls `stop` when configured. It accepts the full address, or the recorded name when the worker never joined. Only the spawner, an ancestor of the spawner or the human at a terminal may end it. A joined worker must still sit under that spawner across machines; a record cannot authorize stopping someone else's worker.

Stop and status read one JSON line on stdin, then EOF:

```json
{"scp":1,"event":"stop","name":"rev","runner":"vm","parent":"me/laptop/lead","address":"me/vm/rev","machine":"vm","ref":"i-0abc123"}
```

Status uses the same fields with `"event":"status"`. `address`, `machine` and `ref` are optional, as recorded. Neither input carries a credential, message body or grant. Both run in the user's home directory with the broker's environment without SCP variables other than `SCP_DIR`. Spawn keeps its spawner environment and requested working directory. Stdout is capped at 4096 bytes and cleaned, redacted stderr at 2048 bytes, with a bounded pipe drain.

Stop needs no stdout. `swarm end` prints the runner and one of `stopped`, `declined`, `failed`, `timeout` or `none` (no configured stop), and exits 1 on `failed` or `timeout`. Its JSON result is `{endpoint?, held: false, runner: {name, stop, code?, stderr?}}`. Ending a via record stops future status checks even if stop fails; another end retries stop.

Status prints one JSON object on exit 0:

```json
{"state":"running","detail":"session ready","attach":"ssh vm -t tmux attach -t rev"}
```

`state` matches `^[a-z][a-z0-9-]{0,31}$`. Optional `detail` is printable, at most 200 characters. Optional `attach` follows the spawn reply's rules and replaces the recorded attach for display. Malformed output or exit 77 yields `unknown`; other non-zero exits yield `error` with `exit N`, and a timeout yields `error` with `timeout`. Secret-looking fields are dropped. The view's `runner.status` is `{state, detail?, at}`, with an ISO timestamp. Only list and peek trigger status, for records that have not ended. Runs happen in parallel, each within its status timeout, and results are cached per record for 15 seconds. Nothing polls in the background. Peek of a via worker shows status and runner metadata, without fetching remote turns. A spawn without an address can still be ended by name but adds no endpoint view metadata.

**What the runner does.** Everything that starts the worker: pick or boot the machine, provision the harness's credentials there from your account, and start the harness. The machine must be logged in to the same account (`swarm login`) with its broker linked to the hub (`swarm cloud enable`). There the runner runs:

```sh
swarm spawn --name rev --under me/laptop/lead -- codex exec "..."
```

`--under` naming an agent on another machine runs the harness linked under it, without a grant: the worker joins as a root of that machine, linked to its parent across machines. When the harness exits, the spawn sends the parent the handback (`worker me/vm/rev finished (exit 0)` and the output) and marks the worker done.

A runner over ssh that keeps the worker in `tmux` can be a few lines:

```sh
#!/bin/sh
request=$(cat)
q() { printf '%s' "$request" | jq -r "$1"; }
name=$(q .name)
case $(q .event) in
  stop) ssh vm "tmux kill-session -t $(q '.name | @sh')"; exit $? ;;
  status)
    if ssh vm "tmux has-session -t $(q '.name | @sh')"; then
      printf '{"state":"running"}\n'
    else
      printf '{"state":"gone"}\n'
    fi
    exit 0 ;;
esac
spawn="cd $(q '.cwd | @sh') && swarm spawn --fg --name $name --under $(q .join.under) -- $(q '.cmd | @sh')"
ssh vm "tmux new-session -d -s $name $(printf '%s' "$spawn" | jq -Rr @sh)" || exit $?
printf '{"address":"me/vm/%s","machine":"vm","attach":"ssh vm -t tmux attach -t %s"}\n' "$name" "$name"
```

The handback is an ordinary message from the worker through the hub, subject to scope and the judge. A worker on another machine has no steer key, no stop push and no resume with late steers, and the spawner's grant caps do not reach it. Planned: a one-time join grant, so the remote machine needs no standing login.

## What SCP never does

- See, store or carry a credential. Messages, wake metadata, runner requests and replies, and the hub carry none, and SCP runs no credentials command. Your waker or runner provisions credentials itself, from the account that owns the endpoint.
- Pick credentials from a sender. A wake's `from` and `from_account` are for routing and display only.
- Hand a message body or attachment to a waker, a machine waker or a runner. They get metadata only.
- Show a machine waker's URL or secret once registered.
- Boot a VM, resume a session or open a terminal. That is your command's job.
