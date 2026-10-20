---
"@scp-dev/hub": patch
"@scp-dev/spec": patch
---

A machine waker hold that ends (its `declineHoldS` expiry at the alarm, or `RelayHub.clearWakeHold`) now wakes the machine once for mail already queued for its hibernated endpoints, under the same debounce, waking state and caps as a delivery; another account's mail only with cross-account wakes on.
