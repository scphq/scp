# Ambient agents

An ambient agent runs without a person at a terminal: a CI job, a cron task, a cloud runner. It joins your org's hub with an org API token instead of a device login.

## Mint a token

1. Sign in at [app.scp.dev](https://app.scp.dev) and open your org.
2. Under **Tokens and devices**, name the token (`ci-nightly`) and pick an expiry: 7, 30 or 90 days, a year, or never.
3. Copy the token. It starts with `scp_t_` and is shown once; the relay stores only its hash.

A token acts as a member of one org on your behalf. Every endpoint it creates carries the label `token=<name>`, which it cannot drop. It stops working when it is revoked, when it expires or when you leave the org. Revoking it closes its connections at once.

## Use it

Set `SCP_TOKEN` and the CLI uses it for the active relay, ahead of any stored login:

```sh
export SCP_TOKEN=scp_t_...
export SCP_MACHINE=ci          # this machine's name on the hub
```

Or save it once and link a long-lived runner:

```sh
swarm up --token "$SCP_TOKEN" --machine runner-1
```

A token acts as an agent, so give it a handle with `--as`.

## Send from a job

`--cloud` (or `SCP_TRANSPORT=cloud`) sends a messaging command straight to the hub, with no local broker:

```sh
swarm send --cloud --as nightly laptop/lead "Nightly build failed: 3 parser tests."
swarm inbox --cloud --as nightly --wait 50
```

`laptop/lead` is the agent `lead` on the machine `laptop` of the same org. Replies to `nightly` wait in its hub inbox until the next run reads them.

## Run agents on a runner

To run harnesses on the runner and let them reach the rest of the org, link its broker to the hub:

```sh
swarm up --token "$SCP_TOKEN" --machine runner-1
swarm spawn --as runner --name triage -- claude -p "Triage the new issues"
```

`swarm up` saves the token, links the broker to the hub and installs the hooks and MCP server in every harness on the runner. Workers spawned there are addressable from any linked machine as `runner-1/triage`.

## A cron job

`laptop/me` is the person at the machine `laptop`.

```sh
# crontab: every morning at 07:00
0 7 * * * SCP_TOKEN=scp_t_... SCP_MACHINE=cron swarm send --cloud --as digest laptop/me "Daily digest ready."
```

## In CI

```yaml
# a CI step
- run: npm i -g @scp-dev/cli
- run: swarm send --cloud --as ci laptop/lead "Deploy to staging finished."
  env:
    SCP_TOKEN: ${{ secrets.SCP_TOKEN }}
    SCP_MACHINE: ci
```

Keep the token in the CI secret store. Mint one token per job, so you can revoke one without the others, and see which job created which endpoint from its `token=<name>` label.
