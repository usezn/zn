### Security
- The Rust gateway's audit database is now created readable only by your user (mode 0600, with its `-wal` and `-shm` files; a new parent directory gets 0700), and the gateway refuses to open an existing database that group or others can read. On Windows nothing changes.
- The Rust gateway no longer needs the management API key on its command line, where other local users can read it in the process list. Use `ZN_API_KEY`, `--api-key-file <path>` (refused if group or others can read it) or `--api-key-stdin`. `--api-key` still works for now but is deprecated and prints a warning.
