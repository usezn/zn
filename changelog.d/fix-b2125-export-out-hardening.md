### Security

- `zn vault log export --otlp` no longer exports an audit log that was not verified unless you add `--unverified` (a locked vault cannot check the chain), and `--out` now refuses a symbolic link or a folder instead of writing through it. An existing file is always replaced by a private (0600) one.
