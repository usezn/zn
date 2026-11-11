### Fixed
- `zn-gate analyze` treats text made only of spaces or line breaks like empty text: it prints the usage and exits with the usage code (`2` in the Python package, `1` in the npm package) instead of allowing the text.
