### Fixed
- `zn audit --approve` and the vault now say "is on a read-only disk" (and the same plain sentences for a full disk or a missing folder) instead of printing a raw `EROFS` or `ENOENT` error.
