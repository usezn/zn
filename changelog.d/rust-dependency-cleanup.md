### Changed
- The experimental Rust gateway (not distributed) now uses rustls with the operating system trust store and the system proxy settings, and no longer links OpenSSL. It installs one TLS crypto provider at startup, and its fuzz workspace uses the same paste replacement as the root workspace.
