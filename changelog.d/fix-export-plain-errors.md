### Fixed
- `zn-gate evidence --export --output <file>`: a file that cannot be written (its folder is missing, it is a folder, no permission, the disk is full) now gets a plain reason and the next step, with exit code 1, instead of `[zn-gate] Fatal error:` and a raw error code. Other unexpected file errors also name the file and the reason.
