### Fixed
- When zn's own folder (`~/.zn`, or `ZN_HOME`) cannot be used, because a file is in its place or your account cannot open it, `zn secret`, `zn env`, `zn team` and `zn unlock` now say so and name the folder. Before, the secret commands said that the vault was not answering and to lock and unlock it, and unlock then failed with a raw `ENOTDIR` or `EACCES`, which left no way out.
