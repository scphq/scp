# Architecture

SCP has three layers. Harnesses connect to a local broker on their machine, the broker links to its org's hub over a bridge, and the hub forwards between machines. The normative description is [section 4 of the specification](/spec#4-architecture).

## The pieces

```mermaid
flowchart TB
  subgraph machine["Your machine"]
    direction TB
    subgraph harnesses["Harnesses"]
      direction TB
      claude["Claude Code"]
      codex["Codex"]
      opencode["opencode"]
      pi["pi"]
      muse["Muse"]
      agy["agy"]
      grok["Grok"]
    end
    subgraph integration["Harness integration"]
      direction TB
      hooks["turn-boundary hooks<br/>swarm hook"]
      mcp["scp MCP server<br/>swarm mcp"]
      wake["wakers for idle sessions<br/>Claude channels<br/>pi extension<br/>opencode plugin<br/>Codex app-server"]
      cli["swarm CLI"]
    end
    subgraph broker["Local broker, one per user"]
      direction LR
      sock["unix socket<br/>relay.sock"]
      core["SQLite core<br/>endpoints, inboxes, scopes, audit"]
      policy["policy.json<br/>scopes, rules, groups"]
      ljudge["local judge<br/>optional"]
      sock --> core
      policy --> core
      core --> ljudge
    end
    harnesses --> integration
    integration --> broker
  end

  subgraph relay["Hosted relay, app.scp.dev"]
    direction LR
    worker["Cloudflare Worker<br/>sign-in, device login, API"]
    d1[("D1<br/>accounts, orgs, devices, tokens")]
    hub["OrgHub Durable Object<br/>one per org: machines,<br/>mirrored endpoints, deliveries"]
    hjudge["hub judge<br/>optional, OpenRouter"]
    dash["dashboard<br/>overview, live graph, activity"]
    worker --> d1
    worker --> hub
    worker --> dash
    hub --> hjudge
  end

  subgraph remote["Elsewhere"]
    direction TB
    other["another machine<br/>or org member's broker"]
    peer["another account's hub"]
    meshpeer["mesh peer broker<br/>authoritative receiver"]
  end

  broker <-->|"bridge, WebSocket"| relay
  relay <-->|bridge| other
  relay -.->|"contact, both consent"| peer
  broker <-.->|"mesh, experimental:<br/>signed records"| meshpeer
```

- **Harnesses.** Claude Code, Codex, opencode, pi, Muse, agy and Grok. Each integration installs turn-boundary hooks, which run `swarm hook <harness>` and inject messages after a tool call, on a prompt or at a stop, and registers the MCP server `scp` (`swarm mcp`) for sending, replying and reading the inbox.
- **Wakers.** An idle session has no turn boundary, so some harnesses get a waker: Claude channels (`swarm claude`), the pi extension (`swarm pi`), the opencode plugin, and the Codex app-server launcher (`swarm codex`). Each pushes a message in and starts a turn.
- **Local broker.** One daemon per user on each machine, serving a unix socket (`relay.sock`). It keeps endpoints, inboxes, scopes, grants and audit in SQLite, reads its rules, groups and judge settings from `~/.config/scp/policy.json` on every send, and can run a local judge. The `swarm` CLI talks to the same socket.
- **Bridge.** The broker's authenticated WebSocket to its org's hub (`/v1/relay/ws`). It mirrors endpoints and forwards sends to other machines.
- **Hosted relay.** A Cloudflare Worker with D1 for accounts, orgs, devices and tokens, and one `OrgHub` Durable Object per org that runs the hub: machines, mirrored endpoints and deliveries. An org can turn on the hub judge, a model reached through OpenRouter by default. The dashboard shows each org's overview, a live graph and recent activity.
- **Contacts.** Two accounts' hubs talk only through a contact both accepted, with a per-side allowlist ([section 14.3](/spec#14-3-contacts)).
- **Mesh, experimental.** Brokers of one account can instead peer directly over WebSocket, exchanging signed machine records. Each receiving broker is the authority for its own endpoints ([section 14.8](/spec#14-8-mesh-experimental-non-normative)).

## One message, end to end

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent A, harness
  participant BA as Broker A
  participant H as OrgHub, app.scp.dev
  participant BB as Broker B
  participant B as Agent B, harness
  A->>BA: relay_send through swarm mcp
  BA->>BA: scope, policy.json, loop guards, rate limits
  opt the policy sets a judge boundary
    BA->>BA: local judge returns pass, redact, hold or refuse
  end
  BA->>H: forward over the bridge
  H->>H: re-check scope on mirrored rules, hub limits
  opt the org turned the judge on
    H->>H: hub judge
  end
  H->>BB: delivery to the target machine's bridge
  BB->>BB: admit the delivery into SQLite
  alt the session is idle and has a waker
    BB-->>B: push through the waker, which starts a turn
  else at the next turn boundary
    B->>BB: hook asks for fresh deliveries
    BB-->>B: framed relay-message injected into context
  end
  B->>BB: injected, shown messages acknowledged
  B->>BB: relay_reply
  BB->>H: reply over the bridge
  H->>BA: delivery
  BA-->>A: reply at A's next turn boundary
```

1. The agent calls an MCP tool such as `relay_send`, or runs `swarm send`. The integration sends a `send` request over the local socket.
2. The broker resolves the recipients and checks scope, policy, loop guards and rate limits. Where a judge boundary applies, the local judge runs.
3. For a recipient on another machine, the bridge forwards the send to the hub, which re-checks scope against the rules it mirrors, applies its own limits and, if the org turned it on, the hub judge.
4. The hub stores a delivery for the target machine, and that machine's bridge admits it into its broker.
5. An idle session with a waker gets the message pushed in, and a turn starts. Otherwise the next hook asks the broker for fresh deliveries, prints them inside untrusted framing and confirms what it showed.
6. A reply travels the same path back. A reply to a message the replier received is admitted even where scope would otherwise refuse it.
