### Fixed
- The vault now checks the format version of its files and audit records. A vault written by a newer zn-gate is refused with a message that says to update zn-gate and that your secrets are not lost, and it is never rewritten or offered a reset.
