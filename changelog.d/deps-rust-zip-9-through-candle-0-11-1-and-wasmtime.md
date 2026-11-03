### Security
- The Rust gateway builds with zip 9.3.0 (through candle 0.11.1) and wasmtime 48.0.8, which fix RUSTSEC-2026-0429 (zip 8.6.0 could abort the process on an archive entry that is a symlink with a large declared size; the gateway never extracts archives) and RUSTSEC-2026-0422, RUSTSEC-2026-0423 and RUSTSEC-2026-0424 (checks between WebAssembly components).
