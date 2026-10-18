---
"@scp-dev/core": minor
"@scp-dev/cli": minor
"@scp-dev/spec": minor
---

`swarm agy` and `swarm grok` run the harness headless and wake it: the launcher holds the endpoint, and each batch of new messages becomes a turn that resumes the same conversation (`agy --conversation <id> -p`, `grok --resume <id> -p`). grok's session id is preassigned with `-s`; agy's scp hooks report the conversation it opened. The endpoint advertises the new wake values `agy-resume` and `grok-resume`. Interactive flags are refused.
