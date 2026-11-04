---
"@scp-dev/cli": minor
---

Under `SCP_NATIVE=1` the CLI hands whoami, set-now, set-status, set-title, event and daemon to the native `swarm`, in place of the Node process where the runtime has `process.execve`. `SCP_NATIVE_TS=<verbs|*>` keeps verbs on the TypeScript CLI.
