---
"@scp-dev/core": minor
"@scp-dev/hub": minor
"@scp-dev/broker": minor
"@scp-dev/spec": patch
---

Default reach: an agent with no list now sees and messages its own tree, every root of its account on any machine, contacts' endpoints and the human, and no longer another tree's children; an agent's own rules, its groups and caps other agents set only narrow within it, and only the human, the policy or a `via` widening reaches further; `open` names this default. A root no longer sees another tree's worker that may message it, though it still reads and answers its messages. Another machine's row counts as a root only when its machine mirrored it at depth 0, so a hub or broker never takes an unplaced row for a root. SPEC sections 10.1, 10.3, 10.7 and 11.2 describe it.
