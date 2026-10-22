---
"@scp-dev/core": patch
"@scp-dev/hub": patch
"@scp-dev/broker": patch
"@scp-dev/cli": patch
---

The broker's hot paths no longer scale with every endpoint it ever saw. A hello reads only the claimed row instead of every endpoint's view, `list` and `snapshot` read only rows they could show, and calls that visit every row derive each row's scope once per request. Ended subagent and lineage child rows offline for a day with no unread mail are retired by the sweep (`endpointRetireS`, `Infinity` keeps them). A hook's process table read gives up after 1.5 s.
