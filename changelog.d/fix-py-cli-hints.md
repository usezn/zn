### Fixed
- `zn-gate analyze` in the Python package no longer stops with a bare "unrecognized arguments" when the text is not in quotes (or PowerShell split it): the words are joined into one text, as in the npm package. With no text at all it says to put the text in double quotes and exits `2`.
- When `zn-gate scan` (Python package) finds a secret, its "Next:" step now says that the `npx` command needs Node.js and what to do without it: move the value out of the file into an environment variable (the Python package has no vault).
