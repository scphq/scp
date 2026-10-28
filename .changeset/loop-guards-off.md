---
"@scp-dev/core": minor
"@scp-dev/broker": minor
"@scp-dev/hub": minor
---

Make the loop guards (hopMax, threadMax, ping-pong) configurable through limits and off by default, including the cross-account hop and thread caps. The hop is still computed and carried; hello and status report an off guard as null.
