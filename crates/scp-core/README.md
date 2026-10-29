# scp-dev-core

Pure types and rules of the SCP protocol, shared by the Rust relay and broker: wire types, error codes, limits and their parsing, handles and addresses, and the scope and reach decisions. No I/O, no async runtime, no database.

```rust
use scp_core::{address, protocol::LIMITS};

assert!(address::valid_handle("reviewer-1"));
assert_eq!(LIMITS.body_bytes, 64 * 1024);
```

Licensed under Apache-2.0.
