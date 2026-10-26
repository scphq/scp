---
"@scp-dev/core": minor
"@scp-dev/broker": minor
"@scp-dev/cli": minor
"@scp-dev/spec": minor
---

Agent names survive client restarts: a session resumed in process rehomes its fresh endpoint onto its named one, a forked Claude Code session claims the session it forks as `harness_origin` and takes that endpoint back, and a resume takes back a row whose harness process no longer runs inside a broker restart's grace window. New `relink` method and `swarm relink [--dry-run]` repair endpoints stranded earlier, for the human at a terminal.
