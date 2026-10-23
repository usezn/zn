### Fixed
- The Python credential masker no longer loses data when two different secrets are used as keys of the same object, or as members of the same set. Both masked to the same text, so one entry disappeared; now every entry is kept and masked keys that end up with the same text are numbered ("<text> #2").
