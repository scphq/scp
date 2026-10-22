---
"@scp-dev/cli": minor
---

A spawn without scope flags no longer caps the worker to its parent: the grant carries no caps, so the worker has the default reach and messages its siblings, its whole tree and the roots.
