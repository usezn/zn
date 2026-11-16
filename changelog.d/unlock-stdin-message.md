### Fixed
- `zn unlock --passphrase-stdin` with nothing on standard input now says that no passphrase was read and shows how to pipe one in, instead of "passphrase must be at least 12 characters". The exit code is unchanged. A short passphrase piped in still gets the 12-character message.
- On Node.js 18, `zn unlock` no longer prints an `ExperimentalWarning` about X25519 on stderr. Only that warning is hidden; other warnings are still shown.
