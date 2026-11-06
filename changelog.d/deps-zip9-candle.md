### Security
- The Rust gateway builds with zip 9.3.0 (through candle 0.11.1), which fixes RUSTSEC-2026-0429: zip 8.6.0 could abort the process on an archive entry that is a symlink with a large declared size. The gateway never extracts archives.
