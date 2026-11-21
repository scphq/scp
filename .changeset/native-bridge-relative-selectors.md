---
"@scp-dev/cli": patch
---

The native broker's bridge no longer drops every endpoint of another machine when one of them has a relative `tree:` selector in its rules or caps (`the endpoints of <machine> were not applied: an endpoint's caps is not valid`), which left that machine's agents unlisted and unreachable. It now takes the same selectors in a mirrored scope as the hub and the TypeScript broker: `tree:` selectors are accepted and `group:self` is refused.
