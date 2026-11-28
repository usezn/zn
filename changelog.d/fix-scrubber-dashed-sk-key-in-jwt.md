### Fixed
- The Node.js package redacts an `sk-` style API key that has hyphens or underscores in its body (40 to 200
  characters), as the Python package already did. Before, such a key stayed readable in prose, in `NAME=value`
  lines and inside a JWT signature. A JWT whose signature holds such a key is now redacted whole.
