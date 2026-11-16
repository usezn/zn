### Fixed
- On Linux, a full disk quota is now reported as "Your disk quota is used up, so ... cannot be written" instead of "unknown error" (hooks install, disconnect, init and the vault).
- `zn secret set`, `zn secret rm` and `zn env shadow` now say why the vault could not be written (full disk, full quota or no permission) instead of "internal error". Other details stay hidden.
