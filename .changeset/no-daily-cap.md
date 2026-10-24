---
"@scp-dev/core": patch
"@scp-dev/broker": patch
"@scp-dev/cli": patch
---

The local broker no longer caps a day's messages unless `SCP_DAILY_CAP` sets one. A hub keeps its 2000 a day.
