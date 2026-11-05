---
"@scp-dev/cli": minor
"@scp-dev/spec": patch
---

Under `SCP_NATIVE=1` the native `swarm` now answers every local word itself: `help`, `--help`, `-h`, `<verb> --help`, `version`, a bare `swarm` and an unknown command, byte for byte as the TypeScript CLI prints them, and `swarm mcp` and `swarm hook` go through the router like any other verb (a hook stays on TypeScript where the runtime has no `process.execve`). Only the experimental `swarm mesh` stays on TypeScript. When no `swarm-verbs.json` lies beside the binary and `swarm __verbs` does not answer, the router now says so on stderr and logs `slow` instead of moving to TypeScript silently, and it waits 60 s rather than 10.
