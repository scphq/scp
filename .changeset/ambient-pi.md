---
"@scp-dev/core": patch
"@scp-dev/broker": patch
"@scp-dev/hub": patch
"@scp-dev/cli": patch
"@scp-dev/pi": patch
---

Ambient pi swarms come up and stay clean. A broker whose state directory was wiped or whose socket another broker took over stops, so its shims reconnect to the live one. A pi session starts its shim only once the previous one exited and reports a shim that could not claim the endpoint, and a shim exits once its harness is gone. A named relaunch, or a session its harness restarted in process, takes back its own endpoint instead of minting a `-2`. A broker linked again under a new machine name relabels its endpoints, and bridges drop the rows of released machines and of their own former name. `swarm --version` reads the installed package.json, and a closed stdout pipe ends a command quietly.
