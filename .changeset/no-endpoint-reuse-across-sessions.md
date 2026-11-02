---
"@scp-dev/broker": patch
"@scp-dev/cli": patch
"@scp-dev/core": patch
"@scp-dev/spec": patch
"scp-relay": patch
---

An endpoint's name, mail and title never pass to an unrelated session. A claim takes over a released endpoint of another harness session only at a handle it was given (never a derived default it walked to), with the grant that endpoint spent, or from the harness process that holds it; the CLI marks its default handles with the new claim field `derived`. A session whose shim takes back its own name after its hooks claimed a default one is no longer moved back onto that default. `swarm relink --check` lists each endpoint at a background session's name, or moved off it, that another session now holds, and changes nothing.
