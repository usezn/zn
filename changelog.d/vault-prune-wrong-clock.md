### Fixed
- Unlocking the vault no longer deletes your token maps when the system clock is wrong. The 30-day cleanup is skipped, with a one-line warning, when the newest map is dated in the future or the clock is more than 400 days ahead of it.
