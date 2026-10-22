### Fixed
- The Rust gateway refuses a stdin message over `server.stdio_max_message_bytes` (default 1 MiB, the same as the WebSocket limit) with a JSON-RPC error that names the limit and how to raise it.
- The Rust gateway embeds a very long tool call in bounded head and tail windows and stores only a bounded copy of it in the audit vault (16 KiB) and the vector memory (1 KiB), each with its original length and SHA-256, so one large call no longer takes about a gigabyte of memory or a megabyte of disk.
- `zn mcp` reports its real version instead of a fixed 1.0.0.
