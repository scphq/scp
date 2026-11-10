---
"scp-relay": patch
---

The native broker's takeover of a spawned worker now places the taking endpoint as the TypeScript broker does: under the worker's parent with the grant's caps as well as its own, still a spawned child. It used to link it under that parent by hand instead, which dropped the grant's caps, added the child-default cap and let the endpoint leave, so the same rename, rehome or background hand-off gave different reach and leave rules on the two brokers. A takeover of a cross-machine child now also keeps that child's linked mark as it is.
