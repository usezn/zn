### Security
- Added a writer for private files in the Rust core. It creates the file readable only by its owner (mode 0600 on Linux and macOS, a protected owner-only access list on Windows), never follows symbolic links, and fails instead of leaving a file that other local accounts can read.
