### Fixed
- The hook launcher no longer blocks every tool call when `TMPDIR` names a folder that is missing or cannot be written: it falls back to `/tmp` for its private files. Before, each call was blocked with "its hook failed", and `zn-gate check`, run from your own terminal, found nothing wrong.
- The ZCode launcher, which needs a timer for its deadline, now finds `sleep` in `/usr/bin` and in the NixOS and Guix system folders too, not only in `/bin`. On systems without `/bin/sleep` it blocked every call.
