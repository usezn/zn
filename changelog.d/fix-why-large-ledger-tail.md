### Fixed
- `zn why` reads the evidence log from its end, in blocks, and stops at the record it shows. It no longer fails with a "cannot be read" error on a log over about 512 MB. The explanation is the same as before; the note about unreadable lines counts only the part of the log that was read.
