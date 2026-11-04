### Fixed
- Long commands are now checked within the hook time budget: the check for a path to the installed zn-gate package built while the command runs no longer slows down on commands with many variable starts, and it no longer refuses ordinary work on a checkout of zn-gate that uses variables (for example `sed -i "s/$OLD/new/" packages/zn-gate/...`).
