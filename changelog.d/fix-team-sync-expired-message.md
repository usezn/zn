### Fixed

- `zn team sync` with no network now also says when the saved organization policy has already expired: the policy expired on that date, so the machine is in strict mode (only restrictions apply) until a sync works. The exit code is unchanged.
