### Fixed
- The ZCode hook setup creates its state folder (`~/.zn/state`) owner-only, also under a loose umask, and closes an existing folder that is open to other users.
