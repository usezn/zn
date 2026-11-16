### Changed
- The experimental Rust gateway (not distributed) now uses rustls with the operating system trust store and the system proxy settings, and no longer links OpenSSL. Its dependencies are updated, including quinn-proto and quinn-udp, updated to fix RUSTSEC-2026-0523, RUSTSEC-2026-0524 and RUSTSEC-2026-0538.
