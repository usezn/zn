### Changed
- Three Rust dependencies the gateway never used directly (hyper, tower and governor) are removed from the build manifest. The binary does not change.
