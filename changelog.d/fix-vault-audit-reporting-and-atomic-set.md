### Fixed

- `zn vault log` (and `zn secret log`) with the vault locked no longer looks like a success: it prints `not verified: the vault is locked` first, on stderr, and exits `3` instead of `0`. With no log yet it still exits `0`.
- `zn vault verify` now always says why the audit log failed (a cut line, a bad MAC from an edit or another vault's key, a broken chain link, a gap in the sequence numbers, a record that differs from the vault's checkpoint, a log shorter than the vault remembers) and on which line of the file, instead of only "at record N" with the reason hidden outside verbose mode.
- A change to the vault (setting, removing or adopting a secret, a policy change, a first-use approval) whose audit record cannot be written is now undone at once, so the vault never saves a change without its record when it locks.
- The secrets guide now says which audit log changes the vault cannot detect (records written after the last saved checkpoint, after an unclean stop) and how the repair of a cut last line works.
