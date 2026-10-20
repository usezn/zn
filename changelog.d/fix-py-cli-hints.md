### Fixed
- `zn-gate analyze` in the Python package no longer stops with a bare "unrecognized arguments" when the text is not in quotes (or PowerShell split it): the words are joined into one text, as in the npm package. With no text at all it says to put the text in double quotes and exits `2`.
