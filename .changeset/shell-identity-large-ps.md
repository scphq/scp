---
"@scp-dev/cli": patch
---

A shell keeps its identity when the process table is large or slow: the ps read takes output past 1 MiB, shell commands wait up to 5 s for it (hooks keep 1.5 s), a failed read no longer crashes the walk with a second read, and the shell is told the table could not be read instead of that no harness runs it.
