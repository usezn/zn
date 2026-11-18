### Changed
- The experimental Rust gateway has new robustness tests for its settings, policy, audit database, SIEM export and MCP JSON-RPC readers: random harmless garbage and every cut-short copy of a valid file must be refused without a panic or a hang.
