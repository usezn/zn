### Fixed
- `zn unlock` no longer prints Node's "X25519 is an experimental feature" warning on Node 18 and 20 before its own message; other warnings still show.
- `zn env unshadow` without `--backup` now shows a real example (`zn env unshadow .env --backup ENVBAK_X1A2B3C4DD202601011200`) instead of a placeholder with dots.
