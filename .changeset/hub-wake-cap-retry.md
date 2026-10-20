---
"@scp-dev/hub": patch
"@scp-dev/spec": patch
---

A queued message's machine waker call after a hold ends now counts against the sender account's per-hour cap once per message and window, and a call that only a per-hour cap refused is retried at the alarm once that cap's window resets, instead of waiting for the next new message.
