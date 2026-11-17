### Fixed
- The vault now also ends its session by the system clock, so a laptop that slept past the 8 hour or 30 minute limit locks when it wakes up.
- A wrong system clock no longer deletes the stats history, the saved session settings of running sessions, or a pending team leave, and no longer delays the reload of a changed project rules file.
- `zn vault status` says that the system clock changed when the unlock time shown does not make sense.
