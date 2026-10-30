### Fixed
- The vault token map cleanup no longer deletes maps when the system clock is 31 to 400 days ahead. It remembers the last time it ran on a normal clock and skips the cleanup, with a one-line warning, if the clock has jumped ahead of that.
