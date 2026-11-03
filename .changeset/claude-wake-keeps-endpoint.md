---
"@scp-dev/cli": patch
"@scp-dev/core": patch
"@scp-dev/spec": patch
"scp-relay": patch
---

A removed Claude Code background worker woken by a message keeps its endpoint. The waker sets the resumed session as `SCP_HARNESS_ORIGIN` in the session file it resumes with. A ticketed claim now lets go of the auto-named endpoint the session's hooks registered first, so no `claude-<dir>-<n>` endpoint is left beside the woken worker. When Claude Code brings the session back under a new id, the waker links the new short id to the worker's session file and records the new session id. The policy then stops the worker again, and its next wake resumes the new session.
