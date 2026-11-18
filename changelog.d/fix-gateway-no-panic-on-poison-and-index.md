### Fixed
- Rust gateway: a panic in one request no longer takes the embedding cache down for the rest of the process, and the memory search, the fast-boot embedder and the MCP connection pool return an error instead of panicking on an empty list, a zero dimension or a missing connection slot.
