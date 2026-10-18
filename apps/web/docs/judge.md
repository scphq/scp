# Message judge

The judge has a model read a message before it is delivered. It passes it, redacts personal data, refuses it, or holds it until a person reviews it. It is off unless you turn it on, and without a model and a key it never calls one.

## On the hosted relay

The relay judges one org's messages between its machines once the org's owner turns it on. The relay operator sets the model and the key:

```sh
cd apps/relay
bunx wrangler d1 migrations apply scp-relay --remote     # adds orgs.judge_enabled (migration 0002)
bunx wrangler secret put JUDGE_API_KEY                    # or OPENROUTER_API_KEY
```

and in `wrangler.jsonc`:

```jsonc
"vars": {
  "JUDGE_PROVIDER": "openrouter",
  "JUDGE_MODEL": "<vendor>/<model>"
}
```

| Name | Kind | Purpose |
| --- | --- | --- |
| `JUDGE_API_KEY` | secret | The model key; `OPENROUTER_API_KEY` when unset |
| `JUDGE_PROVIDER` | var | The model's provider, default `openrouter` |
| `JUDGE_MODEL` | var | The model name at that provider; no default |

Without `JUDGE_MODEL` or a key the judge stays inert for every org: no model calls and no holds, whatever an owner turned on.

Each org starts with the judge off. An owner turns it on or off under **Members** in the org on the dashboard. While it is on, every message between the org's machines is judged before the hub delivers it, failing open when the model does not answer in 12 seconds. A held message reaches the sender as `held {hold_id}` and is not delivered; owners and admins see the held messages (sender, recipients, categories, the judge's reason and expiry, never the body) on the same page and release or refuse each one. The sender gets a notice either way. A hold no one reviews expires with the message.

## In a local broker

The broker reads a `judge` section from its policy file, `~/.config/scp/policy.json`:

```json
{
  "rules": [],
  "judge": {
    "mode": "enforce",
    "fail": "open",
    "timeout_s": 12,
    "model": { "id": "openrouter/<vendor>/<model>", "effort": "medium", "key_env": "SCP_JUDGE_KEY" },
    "boundaries": [{ "from": "*", "to": "*" }]
  }
}
```

| Field | Values |
| --- | --- |
| `mode` | `off`, `shadow` (default: deliver, then judge and audit only) or `enforce` |
| `fail` | `open` (default) or `closed` (hold) when the model fails |
| `timeout_s` | 1 to 30, default 12 |
| `model.id` | `provider/name`, for example `openrouter/<vendor>/<model>` |
| `model.effort` | `low`, `medium` (default), `high` or `xhigh` |
| `model.key_env` | The broker environment variable holding the key; or `key_file`, an absolute path read at each call |
| `budget` | `{ "per_minute", "per_hour" }` across the broker, default 120 and 1200 |
| `boundaries` | 1 to 64 `{ from, to, across? }` selectors; the first match judges a message |

Start the broker with the key in its environment (`SCP_JUDGE_KEY=... swarm up`). A key written into the policy is refused. Without a readable key the broker judges with its deterministic pre-filter alone. Held messages are reviewed by the human at a terminal with `swarm holds`.
