---
"@scp-dev/core": minor
"@scp-dev/broker": patch
"@scp-dev/cli": patch
---

A hibernated endpoint (any provider but `spawn`) wakes only for mail sent after its hibernation began; unread mail it already had stays queued and wakes nothing, and the wake request's unread count still counts it. Local agent facts gain `unread_at`. The Claude background idle stop no longer keeps a worker for unread mail, runs its waker after a stop or removal only for mail newer than the first read, and stops a finished worker after 120 s by default (`stop_after_s`).
