### Fixed
- A full disk no longer leaves empty temporary files behind. `zn-gate stats share off` and `zn audit --output` now write through a temporary file that is removed when the write fails, so the file that was there before is kept and no 0-byte file is created.
- `zn-gate stats share off` on a full disk now says that sharing is still on and that the setting did not change, and exits 1. Before, it printed a file name of a temporary file.
- `zn audit --output` on a full disk now prints the same plain sentence as the other commands ("The disk that holds ... is full. Free some space, then try again.") instead of the raw Node error.
- The full-disk sentence is produced by one helper for every command. When a command cannot name the file, it says "the zn file" instead of "a file".
