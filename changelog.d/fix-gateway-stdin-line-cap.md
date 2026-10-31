### Security
- Rust gateway: a JSON-RPC line on standard input is now limited to 16 MiB. A longer line is skipped without being kept in memory and answered with an "Invalid Request" error, so a client that never sends a newline can no longer make the gateway grow without bound.
