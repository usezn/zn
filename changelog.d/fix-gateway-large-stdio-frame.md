### Fixed
- The Rust gateway no longer spends seconds and gigabytes of memory on one very large stdio frame with the neural layer on: the neural layer now reads a bounded window of the call (the rules still check all of it), and the new `server.max_stdin_frame_bytes` setting (default 16 MiB) refuses a larger frame with a JSON-RPC error that names the limit.
