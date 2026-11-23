### Security
- The gateway is built with `url` 2.5.9, which fixes a stack overflow in `Url::origin()` on nested `blob:` URLs (RUSTSEC-2026-0592).
- The gateway is built with `wasmtime` 48.0.9, which fixes eight advisories published on 20 November (RUSTSEC-2026-0566 to RUSTSEC-2026-0573), among them a panic, a process abort and unbounded memory growth through `AsyncWriteStream`.
